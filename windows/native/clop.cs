// clop.exe: the `clop` command on Windows (spec step 25). It runs the installed app's own Electron in Node mode
// (ELECTRON_RUN_AS_NODE=1) with resources\cli.mjs, so the CLI uses the app's sharp and bundled tools, passes the
// arguments through and returns the CLI's exit code. Compiled at build time with the .NET Framework's csc.exe (C# 5).
//
// Electron is a GUI program: it gets the terminal's console only when it attaches to it itself, which it does when it
// has no standard handles. So in a terminal the handles are not passed (Ctrl-C and colours then reach the CLI), and
// when any of them is redirected (a pipe or file, as for `clop mcp serve` or `clop ... > out.txt`) they all are.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

static class ClopStub {
  const string AppExe = "Clop for Windows.exe";
  const uint STARTF_USESTDHANDLES = 0x100, CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, INFINITE = 0xFFFFFFFF;
  const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12, FILE_TYPE_CHAR = 2;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
    public uint dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  delegate bool ConsoleCtrlHandler(uint type);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern int GetFileType(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);

  static IntPtr child = IntPtr.Zero;
  // Kept in a field so the garbage collector never frees the delegate Windows calls.
  static readonly ConsoleCtrlHandler OnCtrl = HandleCtrl;

  static int Main(string[] args) {
    // Explorer's right-click verbs and Send To start this program with `--hidden`: it lets go of the console window Windows gave it
    // (only when not redirected), so the verb shows no window. The flag is not passed on.
    bool hidden = args.Length > 0 && args[0] == "--hidden";
    if (hidden) { string[] rest = new string[args.Length - 1]; Array.Copy(args, 1, rest, 0, rest.Length); args = rest; }
    bool portable;
    string dir = InstallDir(out portable);
    if (dir == null) {
      Console.Error.WriteLine(portable
        ? "The portable Clop for Windows is not running. Start it, then run clop again: the portable app unpacks to a new folder each time it starts."
        : "Clop for Windows is not installed, or was moved. Reinstall it, or run clop.exe from its install folder.");
      return 1;
    }
    string exe = Path.Combine(dir, AppExe), cli = Path.Combine(Path.Combine(dir, "resources"), "cli.mjs");
    var commandLine = new StringBuilder(Quote(exe)).Append(' ').Append(Quote(cli));
    foreach (string arg in args) commandLine.Append(' ').Append(Quote(arg));
    Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");

    var startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    IntPtr input = GetStdHandle(STD_INPUT_HANDLE), output = GetStdHandle(STD_OUTPUT_HANDLE), error = GetStdHandle(STD_ERROR_HANDLE);
    bool redirected = !IsConsole(input) || !IsConsole(output) || !IsConsole(error);
    if (redirected) { startup.dwFlags = STARTF_USESTDHANDLES; startup.hStdInput = input; startup.hStdOutput = output; startup.hStdError = error; }
    else if (hidden) FreeConsole();

    PROCESS_INFORMATION info;
    if (!CreateProcess(exe, commandLine, IntPtr.Zero, IntPtr.Zero, redirected, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref startup, out info)) {
      Console.Error.WriteLine("Could not start " + exe + ": " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
      return 1;
    }
    child = info.hProcess;
    // A job that ends with this process, so closing the terminal or killing clop.exe also ends the CLI and its tools.
    // Not for --async: without the app, the CLI carries on in a detached copy of itself, which must outlive clop.exe.
    if (!IsAsync(args)) {
      IntPtr job = CreateJobObject(IntPtr.Zero, null);
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (job != IntPtr.Zero && SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) AssignProcessToJobObject(job, info.hProcess);
    }
    SetConsoleCtrlHandler(OnCtrl, true);
    ResumeThread(info.hThread);
    CloseHandle(info.hThread);
    WaitForSingleObject(info.hProcess, INFINITE);
    uint code;
    GetExitCodeProcess(info.hProcess, out code);
    return (int)code;
  }

  /** Ctrl-C reaches the CLI itself when it shares the console; this only waits for it, and ends it if it cannot hear. */
  static bool HandleCtrl(uint type) {
    var timer = new Thread(delegate () {
      if (WaitForSingleObject(child, 3000) != 0) TerminateProcess(child, 130);
    });
    timer.IsBackground = true;
    timer.Start();
    return true;
  }

  static bool IsConsole(IntPtr handle) {
    uint mode;
    return handle == IntPtr.Zero || handle == new IntPtr(-1) || (GetFileType(handle) == FILE_TYPE_CHAR && GetConsoleMode(handle, out mode));
  }

  static bool IsAsync(string[] args) {
    foreach (string arg in args) { if (arg == "--") return false; if (arg == "--async") return true; }
    return false;
  }

  /**
   * The folder holding the app: this program's folder or its parent (an install has it in `cli\`), else where the
   * installer or the running portable app recorded it. `portable` says the record came from a portable app.
   */
  static string InstallDir(out bool portable) {
    portable = false;
    string own = Path.GetDirectoryName(System.Reflection.Assembly.GetEntryAssembly().Location);
    foreach (string candidate in new[] { own, Path.GetDirectoryName(own) }) if (IsInstall(candidate)) return candidate;
    using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Software\\Clop for Windows")) {
      if (key == null) return null;
      object flag = key.GetValue("Portable");
      portable = flag is int && (int)flag == 1;
      string recorded = key.GetValue("InstallDir") as string;
      return IsInstall(recorded) ? recorded : null;
    }
  }

  static bool IsInstall(string dir) {
    return !string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, AppExe)) && File.Exists(Path.Combine(Path.Combine(dir, "resources"), "cli.mjs"));
  }

  /** Quotes an argument the way CommandLineToArgvW and the C runtime read it back. */
  static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
    var quoted = new StringBuilder("\"");
    for (int i = 0; ; i++) {
      int backslashes = 0;
      while (i < arg.Length && arg[i] == '\\') { i++; backslashes++; }
      if (i == arg.Length) { quoted.Append('\\', backslashes * 2); break; }
      if (arg[i] == '"') quoted.Append('\\', backslashes * 2 + 1).Append('"');
      else quoted.Append('\\', backslashes).Append(arg[i]);
    }
    return quoted.Append('"').ToString();
  }
}
