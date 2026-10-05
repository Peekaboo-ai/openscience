import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("telemetry", pathlib.Path(__file__).parents[2] / "src/compute/telemetry-probe.py")
telemetry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(telemetry)


class AllocationTests(unittest.TestCase):
    def test_one_broken_device_client_does_not_hide_host_metrics(self):
        def run(argv):
            if argv[0] == "hy-smi":
                raise TimeoutError("Driver timed out")
            return {"status": "ready", "output": "GPU data"}
        with patch.object(telemetry, "run", side_effect=run), patch.object(telemetry, "cpu", side_effect=[(100, 50), (200, 75)]), patch.object(telemetry, "read", return_value="MemTotal: 2048 kB\nMemAvailable: 1024 kB\n"):
            sample = telemetry.host([{"id": "hygon", "command": "hy-smi", "args": []}, {"id": "nvidia", "command": "nvidia-smi", "args": []}])
        self.assertEqual(sample["cpu"]["utilization"], 75)
        self.assertEqual(sample["memory"]["used"], 1024 * 1024)
        self.assertEqual([probe["status"] for probe in sample["probes"]], ["error", "ready"])

    def config(self, **kwargs):
        return dict(scheduler="slurm", jobID="41", source="fixed collector", probes=[], **kwargs)

    def test_pending_jobs_never_contact_a_compute_node(self):
        with patch.object(telemetry, "run", return_value={"status": "ready", "output": "41|PENDING|(null)\n"}) as run:
            self.assertEqual(telemetry.allocation(self.config())["state"], "queued")
            self.assertEqual(run.call_count, 1)

    def test_finished_jobs_do_not_fall_back_to_the_login_node(self):
        with patch.object(telemetry, "run", return_value={"status": "ready", "output": ""}) as run:
            self.assertEqual(telemetry.allocation(self.config())["state"], "finished")
            self.assertEqual(run.call_count, 1)

    def test_nodes_are_revalidated_against_the_allocation(self):
        with patch.object(telemetry, "run", side_effect=[{"status": "ready", "output": "41|RUNNING|n[1-2]"}, {"status": "ready", "output": "n1\nn2\n"}]) as run:
            reading = telemetry.allocation(self.config(node="unrelated"))
            self.assertEqual(reading["state"], "unavailable")
            self.assertEqual(reading["nodes"], ["n1", "n2"])
            self.assertEqual(run.call_count, 2)

    def test_ssh_failure_uses_only_an_existing_slurm_allocation(self):
        with patch.object(telemetry, "run", side_effect=[{"status": "ready", "output": "41|RUNNING|n1"}, {"status": "ready", "output": "n1\n"}, {"status": "ready", "output": "JobId=41\nNodes=n1 CPU_IDs=0-3 GRES=dcu:Hygon:4(IDX:0-3)"}, {"status": "error", "output": "", "detail": "SSH blocked"}, {"status": "ready", "output": json.dumps({"state": "live", "sample": {"hostname": "n1", "acceleratorScope": {"kind": "allocation", "jobID": "41", "expectedDevices": 4}}})}]) as run:
            self.assertEqual(telemetry.allocation(self.config())["state"], "live")
            argv = run.call_args.args[0]
            self.assertEqual(argv[0], "srun")
            self.assertIn("--jobid=41", argv)
            self.assertIn("--overlap", argv)
            self.assertIn("--nodelist=n1", argv)

    def test_job_and_node_injection_are_rejected(self):
        with patch.object(telemetry, "run") as run:
            config = self.config()
            config["jobID"] = "41; touch /tmp/injected"
            with self.assertRaises(ValueError):
                telemetry.allocation(config)
            run.assert_not_called()
        with patch.object(telemetry, "run", side_effect=[{"status": "ready", "output": "41|RUNNING|n1"}, {"status": "ready", "output": "-oProxyCommand=evil"}]):
            with self.assertRaisesRegex(RuntimeError, "node list"):
                telemetry.allocation(self.config())

    def test_pbs_checks_job_ownership_before_contacting_nodes(self):
        output = json.dumps({"Jobs": {"41.server": {"Job_Owner": "someone-else@login", "job_state": "R", "exec_host": "n1/0"}}})
        with patch.object(telemetry, "run", return_value={"status": "ready", "output": output}) as run:
            with self.assertRaisesRegex(RuntimeError, "not owned"):
                telemetry.allocation({"scheduler": "pbs", "jobID": "41.server"})
            self.assertEqual(run.call_count, 1)

    def test_ssh_in_another_job_falls_back_to_the_requested_allocation(self):
        wrong = {"state": "live", "sample": {"hostname": "n1", "probes": [], "acceleratorScope": {"kind": "unavailable", "jobID": "41"}}}
        correct = {"state": "live", "sample": {"hostname": "n1", "acceleratorScope": {"kind": "allocation", "jobID": "41", "expectedDevices": 4}}}
        outputs = ["41|RUNNING|n1", "n1", "JobId=41\nNodes=n1 CPU_IDs=0-3 GRES=dcu:Hygon:4(IDX:4-7)", json.dumps(wrong), json.dumps(correct)]
        with patch.object(telemetry, "run", side_effect=[{"status": "ready", "output": value} for value in outputs]) as run:
            reading = telemetry.allocation(self.config())
            self.assertEqual(reading["sample"]["acceleratorScope"]["kind"], "allocation")
            command = run.call_args.args[0]
            self.assertEqual(command[0], "srun")
            self.assertEqual(json.loads(command[-1])["allocation"], {"jobID": "41", "scheduler": "slurm", "cgroupJobID": "41", "expectedDevices": 4})

    def test_unverified_legacy_samples_cannot_return_whole_node_devices(self):
        legacy = {"state": "live", "sample": {"hostname": "n1", "probes": [{"id": "drm", "output": "eight cards"}]}}
        outputs = ["41|RUNNING|n1", "n1", "JobId=41\nNodes=n1 CPU_IDs=0-3 GRES=dcu:Hygon:4(IDX:0-3)", json.dumps(legacy), json.dumps(legacy)]
        with patch.object(telemetry, "run", side_effect=[{"status": "ready", "output": value} for value in outputs]):
            sample = telemetry.allocation(self.config())["sample"]
        self.assertEqual(sample["probes"], [])
        self.assertEqual(sample["acceleratorScope"]["kind"], "unavailable")

    def test_wrong_scope_identity_count_or_node_cannot_be_accepted(self):
        for change in [{"jobID": "42"}, {"expectedDevices": 8}, {"hostname": "n2"}]:
            scope = dict(kind="allocation", jobID="41", expectedDevices=4)
            scope.update({key: value for key, value in change.items() if key != "hostname"})
            payload = {"state": "live", "sample": {"hostname": change.get("hostname", "n1"), "probes": [{"id": "drm"}], "acceleratorScope": scope}}
            outputs = ["41|RUNNING|n1", "n1", "JobId=41\nNodes=n1 GRES=dcu:Hygon:4(IDX:0-3)", json.dumps(payload), json.dumps(payload)]
            with self.subTest(change=change), patch.object(telemetry, "run", side_effect=[{"status": "ready", "output": value} for value in outputs]) as run:
                sample = telemetry.allocation(self.config())["sample"]
                self.assertEqual(sample["probes"], [])
                self.assertEqual(sample["acceleratorScope"]["kind"], "unavailable")
                self.assertEqual(run.call_args.args[0][0], "srun")

    def test_array_task_fallback_uses_numeric_job_id_and_keeps_user_facing_identity(self):
        correct = {"state": "live", "sample": {"hostname": "n1", "acceleratorScope": {"kind": "allocation", "jobID": "41_3", "expectedDevices": 4}}}
        responses = [{"status": "ready", "output": "41_3|RUNNING|n1"},
                     {"status": "ready", "output": "n1"},
                     {"status": "ready", "output": "JobId=43 ArrayJobId=41 ArrayTaskId=3\nNodes=n1 GRES=dcu:Hygon:4(IDX:4-7)"},
                     {"status": "error", "output": "", "detail": "SSH blocked"},
                     {"status": "ready", "output": json.dumps(correct)}]
        with patch.object(telemetry, "run", side_effect=responses) as run:
            result = telemetry.allocation({"scheduler": "slurm", "jobID": "41_3", "source": "fixed", "probes": []})
            command = run.call_args.args[0]
        self.assertIn("--jobid=43", command)
        self.assertEqual(json.loads(command[-1])["allocation"]["cgroupJobID"], "43")
        self.assertEqual(result["sample"]["acceleratorScope"]["jobID"], "41_3")
        self.assertEqual(result["sample"]["acceleratorScope"]["kind"], "allocation")

    def test_pbs_keeps_host_metrics_but_does_not_claim_accelerator_allocation(self):
        query = json.dumps({"Jobs": {"41.server": {"Job_Owner": "audit@login", "job_state": "R", "exec_host": "n1/0"}}})
        sample = telemetry.host([], allocation={"scheduler": "pbs", "jobID": "41.server"})
        payload = json.dumps({"state": "live", "sample": sample})
        with patch.object(telemetry.getpass, "getuser", return_value="audit"), patch.object(telemetry.os, "name", "nt"), patch.object(telemetry, "run", side_effect=[{"status": "ready", "output": query}, {"status": "ready", "output": payload}]) as run:
            result = telemetry.allocation({"scheduler": "pbs", "jobID": "41.server", "source": "fixed", "probes": []})
        self.assertIn("cpu", result["sample"])
        self.assertIn("memory", result["sample"])
        self.assertEqual(result["sample"]["probes"], [])
        self.assertIn("PBS", result["sample"]["acceleratorScope"]["reason"])
        self.assertEqual(run.call_args.args[0][0], "ssh")


class DeviceScopeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.pcis = ["0000:09:00.0", "0000:36:00.0", "0000:55:00.0", "0000:77:00.0",
                     "0000:85:00.0", "0000:b5:00.0", "0000:d5:00.0", "0000:f5:00.0"]
        for index in range(9):
            device = self.root / ("card" + str(index)) / "device"
            device.mkdir(parents=True)
            (device / "vendor").write_text("0x1a03" if index == 0 else "0x1d94")
            if not index:
                continue
            (device / "uevent").write_text("PCI_SLOT_NAME=" + self.pcis[index - 1])
            (device / "drm" / ("renderD" + str(127 + index))).mkdir(parents=True)
            for key, value in {"mem_info_vram_used": 1024, "mem_info_vram_total": 65536, "gpu_busy_percent": 10}.items():
                (device / key).write_text(str(value))

    def sample(self, allowed, expected=4, context=True):
        config = {"jobID": "885245"}
        if expected is not None:
            config["expectedDevices"] = expected
        with patch.object(telemetry, "job_context", return_value=context), patch.object(telemetry, "accessible", side_effect=lambda path: int(path.name[7:]) - 128 in allowed):
            return telemetry.allocated_devices(config, self.root)

    def test_first_four_are_allocation_devices_despite_nine_drm_cards(self):
        cards, scope = self.sample({0, 1, 2, 3})
        self.assertEqual(scope["kind"], "allocation")
        self.assertEqual([card["id"] for card in cards], ["0x1d94:" + pci for pci in self.pcis[:4]])

    def test_last_four_are_not_replaced_by_the_first_four_or_the_busy_cards(self):
        cards, scope = self.sample({4, 5, 6, 7})
        self.assertEqual(scope["kind"], "allocation")
        self.assertEqual([card["id"] for card in cards], ["0x1d94:" + pci for pci in self.pcis[4:]])

    def test_non_contiguous_allocation_preserves_physical_identity(self):
        cards, scope = self.sample({0, 2, 5, 7})
        self.assertEqual(scope["kind"], "allocation")
        self.assertEqual([card["id"] for card in cards], ["0x1d94:" + self.pcis[index] for index in [0, 2, 5, 7]])

    def test_unrestricted_or_partially_missing_devices_are_unavailable(self):
        for allowed in ({0, 1, 2}, set(range(8)), set()):
            with self.subTest(allowed=allowed):
                cards, scope = self.sample(allowed)
                self.assertEqual(cards, [])
                self.assertEqual(scope["kind"], "unavailable")
                self.assertEqual(scope["expectedDevices"], 4)

    def test_unknown_count_and_wrong_job_never_return_whole_node_cards(self):
        for expected, context in [(None, True), (4, False)]:
            with self.subTest(expected=expected, context=context):
                cards, scope = self.sample(set(range(8)), expected=expected, context=context)
                self.assertEqual(cards, [])
                self.assertEqual(scope["kind"], "unavailable")

    def test_cpu_only_allocation_has_no_accelerators(self):
        cards, scope = self.sample(set(range(8)), expected=0)
        self.assertEqual(cards, [])
        self.assertEqual(scope, {"kind": "allocation", "jobID": "885245", "expectedDevices": 0})

    def test_missing_render_mapping_cannot_silently_hide_a_card(self):
        (self.root / "card1/device/drm/renderD128").rmdir()
        cards, scope = self.sample({0, 1, 2, 3})
        self.assertEqual(cards, [])
        self.assertEqual(scope["kind"], "unavailable")

    def test_host_monitor_keeps_all_devices(self):
        self.assertEqual(len(telemetry.drm(self.root)), 8)

    def test_unknown_allocation_keeps_host_metrics_and_never_invokes_unscoped_clients(self):
        with patch.object(telemetry, "job_context", return_value=True), patch.object(telemetry, "run") as run:
            sample = telemetry.host([{"id": "hygon", "command": "hy-smi", "args": []}], self.root, {"jobID": "885245"})
        self.assertEqual(sample["acceleratorScope"]["kind"], "unavailable")
        self.assertEqual(sample["probes"], [])
        self.assertIn("cpu", sample)
        self.assertIn("memory", sample)
        run.assert_not_called()

    def test_job_context_requires_exact_devices_controller_or_unified_membership(self):
        self.assertTrue(telemetry.job_context("885245", "11:devices:/slurm/uid_1/job_885245/step_extern\n"))
        self.assertTrue(telemetry.job_context("885245", "0::/slurm/job_885245/step_1/task_0\n"))
        self.assertFalse(telemetry.job_context("885245", "11:devices:/slurm/job_8852450/step_1\n"))
        self.assertFalse(telemetry.job_context("885245", "11:devices:/slurm/job_885244/step_1\n"))
        self.assertFalse(telemetry.job_context("885245", "10:freezer:/slurm/job_885245/step_1\n"))

    def test_count_is_per_selected_node_and_not_total_allocation(self):
        details = "AllocTRES=cpu=8,gres/dcu=8\n Nodes=n1 CPU_IDs=0-3 GRES=dcu:Hygon:4(IDX:0-3)\n Nodes=n2 CPU_IDs=0-3 GRES=dcu:Hygon:4(IDX:4-7)"
        with patch.object(telemetry, "run") as run:
            self.assertEqual(telemetry.allocation_devices(details, "n2"), 4)
            run.assert_not_called()
        self.assertIsNone(telemetry.allocation_devices("AllocTRES=cpu=8,gres/dcu=8", "n1"))

    def test_hostlist_count_is_not_multiplied_by_node_count(self):
        with patch.object(telemetry, "run", return_value={"status": "ready", "output": "n1\nn2\n"}):
            self.assertEqual(telemetry.allocation_devices("Nodes=n[1-2] CPU_IDs=0-3 GRES=gpu:a100:4(IDX:0-3)", "n2"), 4)
            self.assertEqual(telemetry.allocation_devices("Nodes=n1,n2 CPU_IDs=0-3 GRES=gpu:a100:4(IDX:0-3)", "n2"), 4)

    def test_explicit_cpu_only_and_unknown_allocations_are_distinct(self):
        self.assertEqual(telemetry.allocation_devices("Nodes=n1 CPU_IDs=0-3 GRES=(null)", "n1"), 0)
        self.assertEqual(telemetry.allocation_devices("AllocTRES=cpu=4,mem=4G,node=1", "n1"), 0)
        self.assertIsNone(telemetry.allocation_devices("JobId=41", "n1"))
        self.assertIsNone(telemetry.allocation_devices("Nodes=n1 GRES=dcu:Hygon:unknown", "n1"))
        self.assertIsNone(telemetry.allocation_devices("Nodes=n1 GRES=tpu:v4:4", "n1"))

    def test_array_tasks_use_the_verified_numeric_cgroup_identity(self):
        self.assertEqual(telemetry.allocation_identity("JobId=43 ArrayJobId=41 ArrayTaskId=3", "41_3"), "43")
        self.assertIsNone(telemetry.allocation_identity("JobId=43 ArrayJobId=41 ArrayTaskId=4", "41_3"))
        self.assertIsNone(telemetry.allocation_identity("JobId=43 ArrayJobId=42 ArrayTaskId=3", "41_3"))
        self.assertIsNone(telemetry.allocation_identity("JobId=43", "41_3"))
        self.assertIsNone(telemetry.allocation_identity("JobId=43", "41"))
        self.assertEqual(telemetry.allocation_identity("JobId=41", "41"), "41")
        with patch.object(telemetry, "job_context", return_value=True) as context:
            cards, scope = telemetry.allocated_devices({"jobID": "41_3", "cgroupJobID": "43", "expectedDevices": 0}, self.root)
        context.assert_called_once_with("43")
        self.assertEqual(scope["jobID"], "41_3")
        self.assertEqual(scope["kind"], "allocation")


if __name__ == "__main__":
    unittest.main()
