"""Bounded, read-only node sampling. Runs without third-party Python packages."""
import concurrent.futures
import errno
import json
import os
import pathlib
import getpass
import re
import selectors
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time


def trusted(path):
    try:
        item = pathlib.Path(path).resolve(strict=True)
        for entry in (item, *item.parents):
            stat = entry.stat()
            if stat.st_uid != 0 or stat.st_mode & 0o022:
                return False
        return True
    except OSError:
        return False


def environment():
    env = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME") if key in os.environ}
    for key in ("PATH", "LD_LIBRARY_PATH"):
        entries = os.environ.get(key, "").split(os.pathsep)
        if key == "PATH":
            entries += ["/usr/bin", "/bin", "/usr/local/bin", "/opt/dtk/bin", "/opt/rocm/bin", "/opt/hyhal/bin"]
        env[key] = os.pathsep.join(dict.fromkeys(item for item in entries if os.path.isabs(item) and trusted(item)))
    for key in ("SLURM_CONF", "PBS_CONF_FILE"):
        value = os.environ.get(key)
        if value and os.path.isabs(value) and trusted(value):
            env[key] = value
    # 这些值限制驱动可见性；逻辑编号不能作为物理设备归属的证明。
    for key in ("CUDA_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "GPU_DEVICE_ORDINAL"):
        value = os.environ.get(key)
        if value is not None and len(value) <= 8192 and re.fullmatch(r"[A-Za-z0-9_,.\-/:]*", value):
            env[key] = value
    env.update(LC_ALL="C", LANG="C", NO_COLOR="1", COLUMNS="220", TERM="dumb")
    return env


def run(argv, timeout=3):
    env = environment()
    executable = shutil.which(argv[0], path=env["PATH"])
    if not executable:
        return {"status": "not_installed", "output": ""}
    if not trusted(executable):
        return {"status": "restricted", "output": "", "detail": "Monitoring requires an administrator-owned client."}
    child = subprocess.Popen([executable, *argv[1:]], cwd="/", env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    streams = selectors.DefaultSelector()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    status = "ready"
    try:
        for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
            os.set_blocking(stream.fileno(), False)
            streams.register(stream, selectors.EVENT_READ, name)
        deadline = time.monotonic() + timeout
        while streams.get_map():
            if time.monotonic() >= deadline:
                status = "timeout"
                break
            for key, _ in streams.select(0.1):
                data = os.read(key.fileobj.fileno(), 8192)
                if not data:
                    streams.unregister(key.fileobj)
                    continue
                target = buffers[key.data]
                if len(target) + len(data) > 262144:
                    status = "error"
                    break
                target.extend(data)
            if status != "ready":
                break
        if status != "ready":
            os.killpg(child.pid, signal.SIGKILL)
        code = child.wait(timeout=max(0.1, deadline - time.monotonic()))
        output = buffers["stdout"].decode("utf-8", errors="replace")
        error = buffers["stderr"].decode("utf-8", errors="replace").strip()
        return {"status": status if status != "ready" else "ready" if code == 0 else "error", "output": output,
                "detail": (error or ("Query timed out" if status == "timeout" else ""))[:500]}
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        streams.close()
        child.stdout.close()
        child.stderr.close()


def read(path):
    try:
        return pathlib.Path(path).read_text()
    except (OSError, UnicodeError):
        return ""


def metric(path, scale=1, signed=False):
    try:
        value = int(read(path).strip())
        return value / scale if value >= 0 or signed else None
    except ValueError:
        return None


def sensor(directories, names, scale, signed=False):
    for name in names:
        for directory in directories:
            value = metric(directory / name, scale, signed)
            if value is not None:
                return value
    return None


def accessible(path):
    try:
        descriptor = os.open(str(path), os.O_RDONLY | os.O_NONBLOCK)
        os.close(descriptor)
        return True
    except OSError as error:
        if error.errno in (errno.EPERM, errno.EACCES):
            return False
        raise RuntimeError("Cannot verify access to accelerator device " + str(path)) from error


def drm(root="/sys/class/drm", allocated=False, device_root="/dev/dri"):
    # 内核指标不受作业内逻辑卡号重映射影响；PCI 地址保持每条曲线对应同一物理设备。
    try:
        cards = sorted((item for item in pathlib.Path(root).iterdir() if re.fullmatch(r"card\d+", item.name)),
                       key=lambda item: int(item.name[4:]))[:256]
    except OSError:
        return []
    result = []
    for card in cards:
        device = card / "device"
        vendor = read(device / "vendor").strip().lower()
        if vendor not in ("0x1d94", "0x1002"):
            continue
        if allocated:
            # sysfs 显示整机设备；只有作业 cgroup 内真正可打开的 render 节点才属于当前分配。
            renders = sorted((device / "drm").glob("renderD*"))
            if not renders:
                raise RuntimeError("Cannot map a physical accelerator to its render device.")
            if not any(accessible(pathlib.Path(device_root) / render.name) for render in renders):
                continue
        try:
            fields = dict(re.findall(r"^(\w+)=(.*)$", read(device / "uevent"), re.M))
            pci = fields.get("PCI_SLOT_NAME", device.resolve().name).lower()
            identified = bool(re.fullmatch(r"[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]", pci))
            identity = pci if identified else card.name
            sensors = sorted((device / "hwmon").glob("hwmon*"))
            used = metric(device / "mem_info_vram_used")
            total = metric(device / "mem_info_vram_total")
            utilization = metric(device / "gpu_busy_percent")
            kind = "DCU" if vendor == "0x1d94" else "GPU"
            result.append({"id": vendor + ":" + identity,
                           "name": ("Hygon DCU" if kind == "DCU" else "AMD GPU") + " · " +
                                   ("PCI " + pci if identified else "DRM " + card.name),
                           "kind": kind, "source": "sysfs",
                           "utilization": utilization if utilization is not None and utilization <= 100 else None,
                           "memoryUsed": used, "memoryTotal": total,
                           "memoryPercent": min(100, 100 * used / total) if used is not None and total else None,
                           "temperature": sensor(sensors, ["temp1_input"], 1000, True),
                           "power": sensor(sensors, ["power1_average", "power1_input"], 1000000)})
        except (OSError, RuntimeError):
            # 热插拔或单卡权限变化不能丢弃其他设备的有效采样。
            continue
    return result


def cpu():
    values = read("/proc/stat").splitlines()
    if not values:
        return None
    ticks = [int(value) for value in values[0].split()[1:9]]
    return (sum(ticks), ticks[3] + ticks[4])


def job_context(job, content=None):
    content = read("/proc/self/cgroup") if content is None else content
    for line in content.splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3 or not ("devices" in parts[1].split(",") or parts[:2] == ["0", ""]):
            continue
        if re.search(r"(?:^|/)job_" + re.escape(job) + r"(?:/|$)", parts[2]):
            return True
    return False


def allocated_devices(config, drm_root):
    scope = {"kind": "unavailable", "jobID": config["jobID"]}
    expected = config.get("expectedDevices")
    if isinstance(expected, int) and not isinstance(expected, bool) and expected >= 0:
        scope["expectedDevices"] = expected
    if config.get("scheduler", "slurm") != "slurm":
        return [], dict(scope, reason="Accelerator allocation verification is not available for this PBS cluster.")
    if not job_context(config.get("cgroupJobID", config["jobID"])):
        scope["reason"] = "Monitoring is not inside the selected job's device allocation."
        return [], scope
    if "expectedDevices" not in scope:
        scope["reason"] = config.get("reason") or "The scheduler did not provide a per-node accelerator allocation."
        return [], scope
    if expected == 0:
        return [], dict(scope, kind="allocation")
    try:
        cards = drm(drm_root, allocated=True)
    except RuntimeError as error:
        return [], dict(scope, reason=str(error))
    if len(cards) != expected:
        return [], dict(scope, reason="The scheduler allocated " + str(expected) +
                        " accelerators on this node, but access could be verified for " + str(len(cards)) + ".")
    return cards, dict(scope, kind="allocation")


def host(specs, drm_root="/sys/class/drm", allocation=None):
    cards, scope = allocated_devices(allocation, drm_root) if allocation else (drm(drm_root), {"kind": "host"})
    if allocation:
        # 未验证设备归属时不能退回整机 CLI；CPU/内存的整节点读数仍然可用。
        specs = []
    def complete(kind):
        matching = [card for card in cards if card["kind"] == kind]
        return bool(matching) and all(card["utilization"] is not None and card["memoryUsed"] is not None
                                      and card["memoryTotal"] is not None for card in matching)
    # 有完整内核读数时避免重复驱动查询，兼容损坏的 CLI JSON 和 Slurm 逻辑卡编号。
    specs = [spec for spec in specs if not ((spec["id"] == "hygon" and complete("DCU")) or
                                          (spec["id"] == "amd" and complete("GPU")))]
    def probe(spec):
        try:
            result = run([spec["command"], *spec["args"]])
            if spec["id"] == "hygon" and result["status"] == "error":
                result = run([spec["command"]], timeout=2)
        except Exception as error:
            # 单个驱动崩溃或超时不能让 CPU、内存和其他设备的有效采样丢失。
            result = {"status": "error", "output": "", "detail": str(error)[:500]}
        return dict(result, id=spec["id"], command=spec["command"])
    before = cpu()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        pending = [pool.submit(probe, spec) for spec in specs]
        time.sleep(0.18)
        after = cpu()
        utilization = None
        if before and after and after[0] > before[0]:
            utilization = max(0, min(100, 100 * (1 - (after[1] - before[1]) / (after[0] - before[0]))))
        memory = dict(re.findall(r"^(\w+):\s*(\d+)", read("/proc/meminfo"), re.M))
        total = int(memory["MemTotal"]) * 1024 if "MemTotal" in memory else None
        available = int(memory.get("MemAvailable", memory.get("MemFree", "0"))) * 1024
        return {"sampledAt": int(time.time() * 1000), "hostname": socket.gethostname(), "acceleratorScope": scope,
                "cpu": {"cores": os.cpu_count() or 0, "utilization": utilization},
                "memory": {"total": total, "used": max(0, total - available) if total is not None else None},
                "probes": [future.result() for future in pending] +
                          ([{"id": "drm", "command": "sysfs", "status": "ready", "output": json.dumps(cards)}] if cards else [])}


def allocation_devices(output, node):
    # 总 AllocTRES 可能跨越多个节点，只能使用所选节点的 GRES 记录。
    for match in re.finditer(r"^\s*Nodes=(\S+)[^\r\n]*?\bGRES=(\S+)", output, re.M):
        expression, gres = match.groups()
        if expression != node:
            if "[" not in expression and "," not in expression:
                continue
            expanded = run(["scontrol", "show", "hostnames", expression])
            if expanded["status"] != "ready" or node not in expanded["output"].split():
                continue
        if gres in ("(null)", "N/A", "none"):
            return 0
        entries = re.sub(r"\([^)]*\)", "", gres).split(",")
        count = 0
        identified = False
        for entry in entries:
            fields = entry.split(":")
            if fields[0].lower() not in ("gpu", "dcu"):
                if fields[0].lower() in ("tpu", "xpu", "mig"):
                    return None
                continue
            if not re.fullmatch(r"\d+", fields[-1]):
                return None
            identified = True
            count += int(fields[-1])
        return count if identified else None
    total = re.search(r"\bAllocTRES=(\S+)", output)
    if total and not re.search(r"(?:^|,)gres/", total.group(1)):
        return 0
    return None


def allocation_identity(output, job):
    actual = re.search(r"\bJobId=(\d+)\b", output)
    if not actual:
        return None
    if actual.group(1) == job:
        return job
    parts = job.split("_")
    parent = re.search(r"\bArrayJobId=(\d+)\b", output)
    task = re.search(r"\bArrayTaskId=(\d+)(?:\s|$)", output)
    if len(parts) == 2 and parent and task and [parent.group(1), task.group(1)] == parts:
        return actual.group(1)
    return None


def allocation(config):
    job = config["jobID"]
    if config["scheduler"] == "slurm":
        if not re.fullmatch(r"\d+(?:_[\d]+)?", job):
            raise ValueError("Invalid Slurm job ID")
        query = run(["squeue", "--noheader", "--me", "--jobs=" + job, "--format=%i|%T|%N"])
        if query["status"] != "ready":
            raise RuntimeError(query.get("detail") or "Cannot read the Slurm allocation")
        row = next((line.split("|") for line in query["output"].splitlines() if line.split("|")[0].strip() == job), None)
        if row is None:
            return {"state": "finished", "nodes": [], "sample": None}
        if row[1].strip() not in ("RUNNING", "COMPLETING"):
            return {"state": "queued", "nodes": [], "sample": None}
        expanded = run(["scontrol", "show", "hostnames", row[2].strip()])
        if expanded["status"] != "ready":
            raise RuntimeError(expanded.get("detail") or "Cannot resolve allocated nodes")
        nodes = expanded["output"].split()
    else:
        if not re.fullmatch(r"[0-9]+(?:\[[0-9]*\])?(?:\.[A-Za-z0-9_.-]+)?", job):
            raise ValueError("Invalid PBS job ID")
        query = run(["qstat", "-f", "-F", "json", job])
        if query["status"] != "ready":
            raise RuntimeError(query.get("detail") or "PBS JSON status is unavailable")
        entry = json.loads(query["output"]).get("Jobs", {}).get(job)
        if not entry:
            return {"state": "finished", "nodes": [], "sample": None}
        if os.name == "posix":
            import pwd
            user = pwd.getpwuid(os.getuid()).pw_name
        else:
            user = getpass.getuser()
        if entry.get("Job_Owner", "").split("@")[0] != user:
            raise RuntimeError("Allocation is not owned by the connected user")
        if entry.get("job_state") != "R":
            return {"state": "queued", "nodes": [], "sample": None}
        nodes = list(dict.fromkeys(part.split("/")[0] for part in entry.get("exec_host", "").split("+") if part))
    if not nodes or len(nodes) > 256 or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,252}", node) for node in nodes):
        raise RuntimeError("Allocation did not return a supported node list (maximum 256 nodes)")
    node = config.get("node") or nodes[0]
    if node not in nodes:
        return {"state": "unavailable", "nodes": nodes, "sample": None,
                "issues": ["The selected node is no longer in this allocation. Select an allocated node."]}
    scope = {"jobID": job, "scheduler": config["scheduler"]}
    expected = None
    if config["scheduler"] == "slurm":
        details = run(["scontrol", "show", "job", "-dd", job])
        identity = allocation_identity(details["output"], job) if details["status"] == "ready" else None
        if identity:
            scope["cgroupJobID"] = identity
            expected = allocation_devices(details["output"], node)
        if expected is not None:
            scope["expectedDevices"] = expected
        else:
            scope["reason"] = "The scheduler did not provide a verifiable accelerator allocation for the selected node."
    command = ["/usr/bin/python3", "-I", "-c", config["source"],
               json.dumps({"mode": "host", "probes": config["probes"], "allocation": scope})]
    # 仅访问调度器刚确认属于当前用户作业的节点，不接受任意主机或远端命令。
    result = run(["ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                  "-o", "ConnectTimeout=3", "-o", "LogLevel=ERROR", "--", node,
                  " ".join(shlex.quote(arg) for arg in command)], timeout=8)
    def decode(result):
        if result["status"] != "ready":
            return None
        try:
            value = json.loads(result["output"])
            return value if isinstance(value, dict) else None
        except (ValueError, TypeError):
            return None
    def verified(value):
        sample = value.get("sample") if value else None
        if not isinstance(sample, dict):
            return False
        checked = sample.get("acceleratorScope", {})
        hostname = sample.get("hostname", "")
        return (expected is not None and checked.get("kind") == "allocation" and checked.get("jobID") == job
                and checked.get("expectedDevices") == expected and isinstance(hostname, str)
                and hostname.split(".")[0] == node.split(".")[0])
    reading = decode(result)
    if config["scheduler"] == "slurm" and not verified(reading):
        # SSH 被集群策略禁止时，在已有分配内执行有时限的采样 step；不提交新的计算作业。
        result = run(["srun", "--jobid=" + scope.get("cgroupJobID", job), "--overlap", "--immediate=2", "--nodes=1", "--ntasks=1",
                      "--cpus-per-task=1", "--nodelist=" + node, *command], timeout=8)
        reading = decode(result) or reading
    if not reading:
        return {"state": "unavailable", "nodes": nodes, "node": node, "sample": None,
                "issues": [result.get("detail") or "The cluster did not allow node monitoring."]}
    sample = reading.get("sample")
    # 防止旧采集器或格式不完整的响应绕过作业范围验证。
    if sample and not verified(reading):
        sample["probes"] = []
        sample["acceleratorScope"] = {"kind": "unavailable", "jobID": job,
            "reason": sample.get("acceleratorScope", {}).get("reason") or
                      "The node did not verify the selected job's accelerator allocation."}
        if expected is not None:
            sample["acceleratorScope"]["expectedDevices"] = expected
    return {"state": reading["state"], "nodes": nodes, "node": node, "sample": sample, "issues": reading.get("issues", [])}


def main():
    config = json.loads(sys.argv[1])
    if config["mode"] == "host":
        result = {"state": "live", "nodes": [socket.gethostname()], "node": socket.gethostname(),
                  "sample": host(config["probes"], allocation=config.get("allocation"))}
    else:
        result = allocation(config)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"state": "unavailable", "nodes": [], "sample": None, "issues": [str(error)[:500]]}))
