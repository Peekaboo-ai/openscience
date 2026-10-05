import importlib.util
import json
import pathlib
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("telemetry_sysfs", pathlib.Path(__file__).parents[2] / "src/compute/telemetry-probe.py")
telemetry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(telemetry)


class SysfsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)

    def card(self, index, vendor="0x1d94", pci="0000:85:00.0", **metrics):
        device = self.root / ("card" + str(index)) / "device"
        device.mkdir(parents=True)
        fields = {"vendor": vendor, "uevent": "PCI_SLOT_NAME=" + pci + "\n", **metrics}
        for name, value in fields.items():
            target = device / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(str(value))
        return device

    def test_physical_devices_ignore_display_controller_and_keep_exact_byte_units(self):
        self.card(0, vendor="0x1a03")
        for index in range(1, 9):
            self.card(index, pci=f"0000:{index * 16:02x}:00.0", gpu_busy_percent=0,
                      mem_info_vram_total=68702699520, mem_info_vram_used=1222914048 if index >= 5 else 2207744,
                      **{"hwmon/hwmon2/temp1_input": 53000, "hwmon/hwmon2/power1_average": 85000000})
        cards = telemetry.drm(self.root)
        self.assertEqual(len(cards), 8)
        self.assertEqual(cards[4]["id"], "0x1d94:0000:50:00.0")
        self.assertEqual(cards[4]["name"], "Hygon DCU · PCI 0000:50:00.0")
        self.assertEqual(cards[4]["memoryUsed"], 1222914048)
        self.assertAlmostEqual(cards[4]["memoryPercent"], 100 * 1222914048 / 68702699520)
        self.assertEqual(cards[4]["temperature"], 53)
        self.assertEqual(cards[4]["power"], 85)
        self.assertEqual(cards[4]["utilization"], 0)

    def test_pci_identity_survives_drm_card_renumbering(self):
        self.card(3)
        first = telemetry.drm(self.root)[0]
        (self.root / "card3").rename(self.root / "card12")
        second = telemetry.drm(self.root)[0]
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(first["name"], second["name"])

    def test_missing_and_invalid_metrics_do_not_hide_other_cards(self):
        broken = self.card(1, gpu_busy_percent=101, mem_info_vram_total=-1, mem_info_vram_used="unavailable")
        (broken / "hwmon/hwmon1/temp1_input").mkdir(parents=True)
        self.card(2, vendor="0x1002", pci="0000:86:00.0", gpu_busy_percent=25,
                  **{"hwmon/hwmon1/temp1_input": -2000, "hwmon/hwmon1/power1_input": 12000000})
        cards = telemetry.drm(self.root)
        self.assertEqual(len(cards), 2)
        for key in ("utilization", "memoryUsed", "memoryTotal", "memoryPercent", "temperature", "power"):
            self.assertIsNone(cards[0][key])
        self.assertEqual(cards[1]["kind"], "GPU")
        self.assertEqual(cards[1]["temperature"], -2)
        self.assertEqual(cards[1]["power"], 12)
        self.assertEqual(cards[1]["utilization"], 25)
        self.assertEqual(telemetry.drm(self.root / "missing"), [])

    def test_host_uses_kernel_metrics_without_querying_duplicate_driver(self):
        self.card(1, gpu_busy_percent=25, mem_info_vram_total=1024, mem_info_vram_used=512)
        sample = telemetry.host([
            {"id": "hygon", "command": "missing-hygon-monitor-client", "args": []},
            {"id": "nvidia", "command": "missing-nvidia-monitor-client", "args": []},
        ], self.root)
        self.assertEqual([probe["id"] for probe in sample["probes"]], ["nvidia", "drm"])
        self.assertEqual(sample["probes"][-1]["status"], "ready")
        self.assertEqual(json.loads(sample["probes"][-1]["output"])[0]["memoryPercent"], 50)

    def test_partial_kernel_metrics_keep_driver_fallback(self):
        self.card(1, gpu_busy_percent=25)
        sample = telemetry.host([{"id": "hygon", "command": "missing-hygon-monitor-client", "args": []}], self.root)
        self.assertEqual([probe["id"] for probe in sample["probes"]], ["hygon", "drm"])


if __name__ == "__main__":
    unittest.main()
