using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

// Compile as WinExe: the launcher itself must never allocate a Windows console.
internal static class CaptainHookLauncher
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    private static extern bool TerminateProcess(IntPtr process, uint code);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedBytes;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    private static string Quote(string argument)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    private static IntPtr InheritStandardHandle(int kind)
    {
        IntPtr result;
        IntPtr current = GetCurrentProcess();
        if (!DuplicateHandle(current, GetStdHandle(kind), current, out result, 0, true, 2))
            throw new InvalidOperationException("Cannot inherit hook standard stream " + kind);
        return result;
    }

    private static int Main(string[] args)
    {
        IntPtr job = IntPtr.Zero;
        var handles = new System.Collections.Generic.List<IntPtr>();
        var child = new ProcessInfo();
        try
        {
            if (args.Length == 0) throw new ArgumentException("A Node hook script or arguments are required.");
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new InvalidOperationException("Cannot create hook process job.");
            var limits = new ExtendedLimits();
            limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(typeof(ExtendedLimits));
            IntPtr memory = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, memory, false);
                if (!SetInformationJobObject(job, 9, memory, (uint)size))
                    throw new InvalidOperationException("Cannot configure hook process job.");
            }
            finally { Marshal.FreeHGlobal(memory); }

            string node = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
                .Where(directory => !String.IsNullOrWhiteSpace(directory))
                .Select(directory => Path.Combine(directory.Trim('"'), "node.exe"))
                .FirstOrDefault(File.Exists);
            if (node == null) throw new FileNotFoundException("node.exe is not available on PATH.");
            var startup = new StartupInfo();
            startup.Size = Marshal.SizeOf(typeof(StartupInfo));
            startup.Flags = 0x100; // STARTF_USESTDHANDLES; forward original pipes without a console.
            handles.Add(startup.Input = InheritStandardHandle(-10));
            handles.Add(startup.Output = InheritStandardHandle(-11));
            handles.Add(startup.Error = InheritStandardHandle(-12));
            var command = new StringBuilder(Quote(node) + " " + String.Join(" ", args.Select(Quote)));
            // Start suspended so no JavaScript or descendants can run outside the cancellation job.
            if (!CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out child))
                throw new InvalidOperationException("Cannot start Node: Win32 error " + Marshal.GetLastWin32Error());
            if (!AssignProcessToJobObject(job, child.Process))
                throw new InvalidOperationException("Cannot attach hook to cancellation job.");
            if (ResumeThread(child.Thread) == UInt32.MaxValue)
                throw new InvalidOperationException("Cannot resume hook process.");
            if (WaitForSingleObject(child.Process, UInt32.MaxValue) != 0)
                throw new InvalidOperationException("Cannot wait for hook completion.");
            uint exitCode;
            if (!GetExitCodeProcess(child.Process, out exitCode))
                throw new InvalidOperationException("Cannot read hook exit code.");
            return unchecked((int)exitCode);
        }
        catch (Exception error)
        {
            if (child.Process != IntPtr.Zero) TerminateProcess(child.Process, 2);
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes("Captain hook launcher failed: " + error.Message + "\n");
                Console.OpenStandardError().Write(bytes, 0, bytes.Length);
            }
            catch { }
            return 2; // Preserve Codex's blocking command-hook failure contract.
        }
        finally
        {
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
            foreach (IntPtr handle in handles) CloseHandle(handle);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
