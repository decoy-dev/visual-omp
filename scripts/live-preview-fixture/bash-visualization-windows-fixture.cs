using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

public static class BashVisualizationWindowsFixture {
    // CRT quoting, including backslashes immediately before quotes and the closing quote.
    public static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append(ch); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(ch);
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    static Process Launch(string executable, string[] args) {
        var quoted = new List<string>();
        foreach (string arg in args) quoted.Add(Quote(arg));
        return Process.Start(new ProcessStartInfo(executable, String.Join(" ", quoted.ToArray())) {
            UseShellExecute = false, CreateNoWindow = true
        });
    }
    static object Identity(Process process, string role, string image, string marker) {
        return new { pid = process.Id, role = role, parentPid = BashVisualizationWindowsInspector.Parent(process.Handle), creation = process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(), image = image, marker = marker };
    }
    public static int Main(string[] args) {
        // Configuration is next to this unique executable, since production removes fixture env vars.
        string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        var json = new JavaScriptSerializer();
        var config = json.Deserialize<Dictionary<string, string>>(File.ReadAllText(Path.Combine(directory, "launcher.json")));
        var nodeArgs = new List<string> {config["sentinel"], "node", directory, config["omp"]};
        nodeArgs.AddRange(args);
        using (var self = Process.GetCurrentProcess())
        using (var node = Launch(config["node"], nodeArgs.ToArray())) {
            string nodeLedger = Path.Combine(directory, "node.json");
            var clock = Stopwatch.StartNew();
            while (!File.Exists(nodeLedger)) {
                if (node.HasExited || clock.ElapsedMilliseconds >= 5000) throw new InvalidOperationException("Node identity unavailable");
                System.Threading.Thread.Sleep(10);
            }
            var nodeIdentity = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(nodeLedger));
            if (Convert.ToInt32(nodeIdentity["pid"]) != node.Id || Convert.ToInt32(nodeIdentity["parentPid"]) != self.Id)
                throw new InvalidOperationException("Node topology differs from owned launch");
            using (var omp = Process.GetProcessById(Convert.ToInt32(nodeIdentity["ompPid"]))) {
                if (BashVisualizationWindowsInspector.Parent(omp.Handle) != node.Id)
                    throw new InvalidOperationException("omp topology differs from owned launch");
                string destination = Path.Combine(directory, "launcher-owned.json");
                File.WriteAllText(destination + ".pending", json.Serialize(new [] {
                    Identity(self, "root", Assembly.GetExecutingAssembly().Location, Assembly.GetExecutingAssembly().Location),
                    Identity(node, "node", config["node"], config["sentinel"]),
                    Identity(omp, "omp", config["omp"], args[Array.IndexOf(args, "-e") + 1])
                }));
                File.Move(destination + ".pending", destination);
                node.WaitForExit(); return node.ExitCode;
            }
        }
    }
}

// Independent evidence observer. Every cleanup acts on a retained native handle, after
// checking its creation time, image and owned command marker. It never kills by PID.
public static class BashVisualizationWindowsInspector {
    [StructLayout(LayoutKind.Sequential)] struct Memory {
        public uint cb, faults;
        public UIntPtr peakWorkingSet, workingSet, peakPaged, paged, peakNonPaged, nonPaged, pagefile, peakPagefile;
    }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("psapi.dll", SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr handle, ref Memory memory, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, IntPtr data, int size, out int required);
    sealed class Owned {
        public IntPtr handle;
        public int pid, parentPid;
        public long creation;
        public string image, marker;
    }
    static readonly Dictionary<string, Owned> held = new Dictionary<string, Owned>();
    public sealed class NativeQueryException : Win32Exception {
        public string NativeApi { get; private set; }
        public bool ExitRechecked { get; internal set; }
        public string ExitConfirmedAt { get; internal set; }
        public NativeQueryException(string api, int error) : base(error) { NativeApi = api; }
    }
    static void Require(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static long Creation(IntPtr handle) {
        FileTime created, exited, kernel, user;
        if (!GetProcessTimes(handle, out created, out exited, out kernel, out user))
            throw new NativeQueryException("GetProcessTimes", Marshal.GetLastWin32Error());
        return ((long)created.high << 32) | created.low;
    }
    static string Image(IntPtr handle) {
        var path = new StringBuilder(32768); int size = path.Capacity;
        if (!QueryFullProcessImageName(handle, 0, path, ref size))
            throw new NativeQueryException("QueryFullProcessImageName", Marshal.GetLastWin32Error());
        return path.ToString();
    }
    static string Command(IntPtr handle) {
        int needed;
        int probeStatus = NtQueryInformationProcess(handle, 60, IntPtr.Zero, 0, out needed);
        if (needed <= 0 || needed > 1024 * 1024) throw new NativeQueryException("NtQueryInformationProcess.CommandLine", probeStatus);
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        try {
            int status = NtQueryInformationProcess(handle, 60, buffer, needed, out needed);
            if (status < 0) throw new NativeQueryException("NtQueryInformationProcess.CommandLine", status);
            int bytes = (ushort)Marshal.ReadInt16(buffer);
            IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size == 8 ? 8 : 4);
            return Marshal.PtrToStringUni(text, bytes / 2);
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    public static int Parent(IntPtr handle) {
        int size = IntPtr.Size * 6, needed;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            int status = NtQueryInformationProcess(handle, 0, buffer, size, out needed);
            if (status < 0) throw new NativeQueryException("NtQueryInformationProcess.Parent", status);
            if (needed != size) throw new InvalidOperationException("Parent identity query returned an invalid size");
            long parent = Marshal.ReadIntPtr(buffer, IntPtr.Size * 5).ToInt64();
            if (parent <= 0 || parent > Int32.MaxValue) throw new InvalidOperationException("Parent identity unavailable");
            return (int)parent;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static bool Exited(Owned item) {
        uint state = WaitForSingleObject(item.handle, 0);
        if (state == 0) return true;
        if (state == UInt32.MaxValue) throw new NativeQueryException("WaitForSingleObject", Marshal.GetLastWin32Error());
        if (state != 258) throw new InvalidOperationException("Unexpected retained process wait state");
        return false;
    }
    static void Validate(Owned item) {
        if (Creation(item.handle) != item.creation || !String.Equals(Image(item.handle), item.image, StringComparison.OrdinalIgnoreCase) ||
            Command(item.handle).IndexOf(item.marker, StringComparison.OrdinalIgnoreCase) < 0)
            throw new InvalidOperationException("Retained process identity changed");
    }
    public static object Pin(string key, int pid, string minimum, string maximum, string image, string marker, string expected) {
        if (held.ContainsKey(key)) {
            Owned previous = held[key];
            if (previous.pid != pid || !String.Equals(previous.image, image, StringComparison.OrdinalIgnoreCase) ||
                (!String.IsNullOrEmpty(expected) && previous.creation != Int64.Parse(expected)))
                throw new InvalidOperationException("Duplicate identity differs from retained process");
            return Snapshot(key);
        }
        if (String.IsNullOrEmpty(marker) || !Path.IsPathRooted(image)) throw new InvalidOperationException("Owned identity required");
        IntPtr handle = OpenProcess(0x00101411, false, pid); // synchronize, query, VM read, terminate
        Require(handle != IntPtr.Zero);
        try {
            long creation = Creation(handle);
            if (creation < Int64.Parse(minimum) || creation > Int64.Parse(maximum) ||
                (!String.IsNullOrEmpty(expected) && creation != Int64.Parse(expected)))
                throw new InvalidOperationException("Process creation time differs from owned launch");
            var item = new Owned {handle=handle, pid=pid, parentPid=Parent(handle), creation=creation, image=image, marker=marker};
            if (Exited(item)) throw new InvalidOperationException("Owned process exited before identity capture");
            Validate(item); held.Add(key, item); handle = IntPtr.Zero; return Snapshot(key);
        } finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
    }
    // A caller supplies its original close deadline as absolute UTC FILETIME. Empty means
    // zero wait. Query failure never changes identity or grants permission to reopen a PID.
    public static object Snapshot(string key) { return Snapshot(key, ""); }
    public static object Snapshot(string key, string exitDeadline) {
        long deadline = String.IsNullOrEmpty(exitDeadline) ? 0 : Int64.Parse(exitDeadline);
        if (deadline < 0) throw new ArgumentOutOfRangeException("exitDeadline");
        Owned item = held[key]; bool exited = Exited(item), exitRechecked = false;
        string confirmedAt = exited ? DateTime.UtcNow.ToFileTimeUtc().ToString() : null;
        NativeQueryException queryFailure = null;
        ulong rss = 0;
        if (!exited) {
            try {
                Validate(item);
                var memory = new Memory(); memory.cb = (uint)Marshal.SizeOf(typeof(Memory));
                if (!GetProcessMemoryInfo(item.handle, ref memory, memory.cb))
                    throw new NativeQueryException("GetProcessMemoryInfo", Marshal.GetLastWin32Error());
                rss = memory.workingSet.ToUInt64();
            } catch (NativeQueryException error) {
                queryFailure = error; exitRechecked = true;
                confirmedAt = ConfirmQueryFailureExit(item, deadline, error).ToString();
                exited = true;
            }
        }
        return new {key=key, pid=item.pid, parentPid=item.parentPid, creation=item.creation.ToString(), image=item.image, marker=item.marker, exited=exited, rssBytes=rss,
            exitConfirmedAt=confirmedAt, exitRechecked=exitRechecked, nativeApi=queryFailure == null ? null : queryFailure.NativeApi,
            nativeError=queryFailure == null ? (int?)null : queryFailure.NativeErrorCode};
    }
    static uint RemainingExitWait(long now, long deadline) {
        // Round down so a native wait cannot be assigned more than the remaining budget.
        if (deadline <= now) return 0;
        return (uint)Math.Min(250L, (deadline - now) / 10000L);
    }
    static long ConfirmQueryFailureExit(Owned item, long deadline, NativeQueryException failure) {
        failure.ExitRechecked = true;
        uint state = WaitForSingleObject(item.handle, 0);
        long confirmedAt = DateTime.UtcNow.ToFileTimeUtc();
        if (state == 258 && deadline > confirmedAt) {
            uint remaining = RemainingExitWait(confirmedAt, deadline);
            if (remaining > 0) {
                state = WaitForSingleObject(item.handle, remaining);
                confirmedAt = DateTime.UtcNow.ToFileTimeUtc();
            }
        }
        if (state == 0) failure.ExitConfirmedAt = confirmedAt.ToString();
        // WAIT_FAILED, a still-live handle, and a late confirmation all retain the original
        // fixed API/error evidence. An identity mismatch never enters this recovery path.
        if (state != 0 || (deadline != 0 && confirmedAt > deadline)) throw failure;
        return confirmedAt;
    }
    static void SelfTestAssert(bool ok, string name) {
        if (!ok) throw new InvalidOperationException("Verifier policy self-test failed: " + name);
    }
    // Windows-only preflight. A private child supplies one immutable process identity.
    // A synchronize-only duplicate deliberately fails native queries on that same object;
    // it is never substituted for a production pin and no PID is reopened.
    public static object VerifierPolicySelfTest() {
        const string key = "__verifier_policy_selftest";
        string image = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        using (var self = Process.GetCurrentProcess())
        using (var child = Process.Start(new ProcessStartInfo(image, "/d /q /c \"set /p fixtureExit=\"") {
            UseShellExecute=false, CreateNoWindow=true, RedirectStandardInput=true, RedirectStandardOutput=true, RedirectStandardError=true
        })) {
            IntPtr handle = IntPtr.Zero;
            try {
                Require(DuplicateHandle(self.Handle, child.Handle, self.Handle, out handle, 0x00100000, false, 0));
                var item = new Owned {handle=handle, pid=child.Id, parentPid=Parent(child.Handle), creation=Creation(child.Handle), image=Image(child.Handle), marker="fixtureExit"};
                Validate(new Owned {handle=child.Handle, creation=item.creation, image=item.image, marker=item.marker});
                long pinnedCreation = item.creation; int pinnedParent = item.parentPid; string pinnedImage = item.image;
                held.Add(key, item);
                NativeQueryException metadataFailure = null;
                try { Snapshot(key); }
                catch (NativeQueryException error) { metadataFailure = error; }
                SelfTestAssert(metadataFailure != null && metadataFailure.NativeApi == "GetProcessTimes" &&
                    metadataFailure.NativeErrorCode == 5 && metadataFailure.ExitRechecked && metadataFailure.ExitConfirmedAt == null &&
                    !Exited(item), "stillLiveAccessDeniedFails");
                NativeQueryException liveDeadlineFailure = null;
                try { Snapshot(key, DateTime.UtcNow.AddMilliseconds(3).ToFileTimeUtc().ToString()); }
                catch (NativeQueryException error) { liveDeadlineFailure = error; }
                SelfTestAssert(liveDeadlineFailure != null && liveDeadlineFailure.ExitRechecked && !Exited(item), "liveDeadlineFails");
                var memory = new Memory(); memory.cb = (uint)Marshal.SizeOf(typeof(Memory));
                bool memoryOk = GetProcessMemoryInfo(item.handle, ref memory, memory.cb);
                int memoryError = Marshal.GetLastWin32Error();
                SelfTestAssert(!memoryOk && memoryError == 5, "nativeMemoryAccessDenied");
                var memoryFailure = new NativeQueryException("GetProcessMemoryInfo", memoryError);
                bool mismatchRejected = false;
                try { Pin(key, item.pid, "", "", item.image, item.marker, (item.creation + 1).ToString()); }
                catch (InvalidOperationException) { mismatchRejected = true; }
                SelfTestAssert(mismatchRejected, "identityMismatchFails");
                child.StandardInput.WriteLine("exit"); child.StandardInput.Flush();
                SelfTestAssert(child.WaitForExit(5000), "ownedChildExit");
                long deadline = DateTime.UtcNow.AddMilliseconds(250).ToFileTimeUtc();
                long metadataConfirmed = ConfirmQueryFailureExit(item, deadline, metadataFailure);
                long memoryConfirmed = ConfirmQueryFailureExit(item, deadline, memoryFailure);
                SelfTestAssert(metadataConfirmed <= deadline && metadataFailure.ExitConfirmedAt == metadataConfirmed.ToString(), "metadataQueryFailureThenExitConfirmed");
                SelfTestAssert(memoryConfirmed <= deadline && memoryFailure.ExitConfirmedAt == memoryConfirmed.ToString(), "memoryQueryFailureThenExitConfirmed");
                bool expiredRejected = false;
                var expiredFailure = new NativeQueryException("GetProcessMemoryInfo", 5);
                try { ConfirmQueryFailureExit(item, DateTime.UtcNow.AddMilliseconds(-1).ToFileTimeUtc(), expiredFailure); }
                catch (NativeQueryException error) { expiredRejected = Object.ReferenceEquals(error, expiredFailure) && error.ExitRechecked; }
                SelfTestAssert(expiredRejected, "deadlineExpiredFails");
                SelfTestAssert(Object.ReferenceEquals(held[key], item) && item.handle == handle && item.pid == child.Id &&
                    item.parentPid == pinnedParent && item.creation == pinnedCreation && item.image == pinnedImage &&
                    item.marker == "fixtureExit", "pinnedIdentityUnchanged");
                SelfTestAssert(RemainingExitWait(100000, 109999) == 0 && RemainingExitWait(100000, 120000) == 2 &&
                    RemainingExitWait(100000, 100000) == 0 && RemainingExitWait(100000, 10000000) == 250, "absoluteWaitBudget");
                return new {passed=true, cases=new [] {"stillLiveAccessDeniedFails", "liveDeadlineFails", "metadataQueryFailureThenExitConfirmed",
                    "memoryQueryFailureThenExitConfirmed", "deadlineExpiredFails", "pinnedIdentityUnchanged", "identityMismatchFails", "absoluteWaitBudget"}};
            } finally {
                held.Remove(key);
                // Only this self-test's retained child handle can be terminated on failure.
                try {
                    if (!child.HasExited) {
                        Require(TerminateProcess(child.Handle, 137));
                        SelfTestAssert(child.WaitForExit(5000), "ownedChildCleanup");
                    }
                } finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
            }
        }
    }
    public static object Kill(string key) {
        Owned item = held[key];
        if (!Exited(item)) {
            Validate(item); Require(TerminateProcess(item.handle, 137));
            if (WaitForSingleObject(item.handle, 5000) != 0) throw new InvalidOperationException("Emergency cleanup did not confirm exit");
        }
        return Snapshot(key);
    }
    public static void Dispose() {
        foreach (Owned item in held.Values) CloseHandle(item.handle);
        held.Clear();
    }
}
