using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Accessibility;
using System.Windows.Automation;

namespace ClopWindows {
  // Windows PowerShell 5.1 runs this helper on an STA thread. No runtime installation needed.
  public static class Bridge {
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [StructLayout(LayoutKind.Sequential)] struct Bounds { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Bounds bounds);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromPoint(Point point, out IAccessible accessible, [MarshalAs(UnmanagedType.Struct)] out object child);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder id);
    delegate IntPtr MouseCallback(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct MouseData { public Point Point; public uint Mouse, Flags, Time; public UIntPtr Extra; }
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int type, MouseCallback callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    delegate void WinEventCallback(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventCallback callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    static readonly WinEventCallback DragEvents = OnDragEvent;
    static readonly MouseCallback MouseEvents = OnMouseEvent;
    sealed class Press { public Point Point; public IntPtr Window; public bool Down; public int Generation; }
    sealed class CheckedPress { public int Generation; public bool Eligible; public string[] Paths; }
    static readonly ConcurrentQueue<Press> Presses = new ConcurrentQueue<Press>();
    static readonly BlockingCollection<Press> Candidates = new BlockingCollection<Press>();
    static readonly ConcurrentQueue<CheckedPress> Checked = new ConcurrentQueue<CheckedPress>();
    static readonly ConcurrentQueue<string> Diagnostics = new ConcurrentQueue<string>();
    static readonly HashSet<long> OwnWindows = new HashSet<long>();
    static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static volatile bool Ended;
    static uint Sequence;
    static IntPtr ForegroundWindow;
    static uint ForegroundProcess;
    static string ForegroundApp = "";
    static readonly string ClipboardOwner = Guid.NewGuid().ToString("N");
    static bool Announced, Eligible, DetectDrag = true;
    static int Generation;
    static Point Start;
    static string[] DragPaths = new string[0];
    static readonly HashSet<string> Extensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".tif", ".tiff", ".heic", ".heif", ".jxl", ".bmp", ".svg" };
    // Every file Clop optimises (core/media/detect.ts): images, videos, audio and PDFs.
    static readonly HashSet<string> MediaExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
      ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".tif", ".tiff", ".heic", ".heif", ".jxl", ".bmp", ".svg",
      ".mp4", ".mov", ".qt", ".m4v", ".webm", ".mkv", ".avi", ".m2v", ".mpg", ".mpeg",
      ".mp3", ".m4a", ".aac", ".wav", ".aif", ".aiff", ".flac", ".ogg", ".opus", ".pdf" };
    const int MaxFiles = 64;
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    // Console.Out is synchronised, so another thread can write whole lines too; it brings its own serializer.
    static void EmitFrom(JavaScriptSerializer json, object value) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
    static void DragDebug(string message) { if (Environment.GetEnvironmentVariable("CLOP_DEBUG_DRAG") == "1") Diagnostics.Enqueue(message); }
    public static void Run() {
      SetProcessDpiAwarenessContext(new IntPtr(-4));
      // Electron pipes UTF-8 JSON. Windows PowerShell's inherited console code page varies
      // by machine, so read and write the pipe streams explicitly to preserve file names.
      Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)));
      Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
      Sequence = GetClipboardSequenceNumber();
      var reader = new Thread(() => { string line; while ((line = Console.ReadLine()) != null) Commands.Enqueue(line); Ended = true; });
      reader.IsBackground = true; reader.Start();
      // Accessibility/COM calls can wait on another app. Keep them away from the hook's
      // message pump, which Windows must be able to call immediately for every mouse event.
      var detector = new Thread(() => {
        try { var desktop = AutomationElement.RootElement.Current.ControlType; } catch { }
        foreach (var candidate in Candidates.GetConsumingEnumerable()) {
          if (Ended) break;
          string[] paths;
          bool eligible = ImageAtPress(candidate.Window, candidate.Point, out paths);
          Checked.Enqueue(new CheckedPress { Generation = candidate.Generation, Eligible = eligible, Paths = paths });
        }
      });
      detector.IsBackground = true; detector.SetApartmentState(ApartmentState.MTA); detector.Start();
      var timer = new System.Windows.Forms.Timer { Interval = 100 };
      timer.Tick += (sender, args) => {
        if (Ended) { Candidates.CompleteAdding(); timer.Stop(); Application.ExitThread(); return; }
        string line;
        while (Commands.TryDequeue(out line)) Handle(line);
        string diagnostic; while (Diagnostics.TryDequeue(out diagnostic)) Emit(new { type = "drag-diagnostic", message = diagnostic });
        // Report which app is in front. Clipboard pickup waits for the user to leave an editor
        // that rewrites the clipboard after every stroke.
        var window = GetForegroundWindow();
        if (window != ForegroundWindow) {
          ForegroundWindow = window;
          uint process = AppProcess(window, out ForegroundApp);
          if (process != ForegroundProcess) { ForegroundProcess = process; Emit(new { type = "foreground", process, app = ForegroundApp }); }
        }
        uint next = GetClipboardSequenceNumber();
        if (next != Sequence) {
          Sequence = next;
          try {
            var contents = Clipboard.GetDataObject();
            // OLE can bump the sequence again when delayed clipboard formats render. Tag ownership
            // explicitly rather than relying only on the sequence captured by SetDataObject.
            if (contents != null && Convert.ToString(contents.GetData("ClopWindows.Owner")) == ClipboardOwner) return;
            if (Excluded(contents)) return;
            // Every listed file goes to the app, which decides by type and settings. `image` also counts image files,
            // for the pickup's editing sessions; `bitmap` is image data alone.
            var paths = FileList();
            bool bitmap = HasBitmap(contents);
            bool image = bitmap || paths.Exists(file => Extensions.Contains(Path.GetExtension(file)));
            bool text = contents != null && contents.GetDataPresent(DataFormats.UnicodeText);
            string owner, aumid; ClipboardSource(out owner, out aumid);
            Emit(new { type = "clipboard", sequence = next, paths = paths.ToArray(), image, bitmap, text, process = ForegroundProcess, app = ForegroundApp, owner, aumid });
          } catch { /* A different app may temporarily hold the clipboard. Retry on its next change. */ }
        }
        DetectImageDrag();
      };
      // Capture the original press before the cursor leaves the item. The mouse hook samples
      // client bounds and queues coordinates; COM work stays outside the input callback.
      var mouseHook = SetWindowsHookEx(14, MouseEvents, GetModuleHandle(null), 0);
      var hook = SetWinEventHook(0x000F, 0x000F, IntPtr.Zero, DragEvents, 0, 0, 2);
      timer.Start(); Emit(new { type = "ready", sequence = Sequence }); Application.Run(); timer.Dispose();
      if (hook != IntPtr.Zero) UnhookWinEvent(hook);
      if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
    }
    // UWP windows sit inside ApplicationFrameHost. Resolve them to the hosted app's process.
    static uint AppProcess(IntPtr window, out string name) {
      name = "";
      if (window == IntPtr.Zero) return 0;
      try {
        uint process; GetWindowThreadProcessId(window, out process);
        name = ProcessName(process);
        if (name == "applicationframehost") {
          var core = FindWindowEx(window, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
          if (core != IntPtr.Zero) { GetWindowThreadProcessId(core, out process); name = ProcessName(process); }
        }
        return process;
      } catch { return 0; }
    }
    // The app that put the clipboard contents there, for the ignored apps: the clipboard owner's process, or the app in
    // front when the clipboard has no owner. Packaged apps also report their AUMID.
    static void ClipboardSource(out string path, out string aumid) {
      var window = GetClipboardOwner();
      if (window == IntPtr.Zero) window = GetForegroundWindow();
      string name;
      ProcessIdentity(AppProcess(window, out name), out path, out aumid);
    }
    static void ProcessIdentity(uint process, out string path, out string aumid) {
      path = ""; aumid = "";
      if (process == 0) return;
      // PROCESS_QUERY_LIMITED_INFORMATION also opens elevated and protected processes.
      var handle = OpenProcess(0x1000, false, process);
      if (handle == IntPtr.Zero) return;
      try {
        var name = new StringBuilder(32768); uint size = (uint)name.Capacity;
        if (QueryFullProcessImageName(handle, 0, name, ref size)) path = name.ToString(0, (int)size);
        var id = new StringBuilder(256); uint length = (uint)id.Capacity;
        try { if (GetApplicationUserModelId(handle, ref length, id) == 0) aumid = id.ToString(); } catch (EntryPointNotFoundException) { }
      } finally { CloseHandle(handle); }
    }
    // For the ignored-apps picker: apps running with a visible window, then Start Menu shortcuts to programs and packaged
    // Start Menu apps. A packaged app is listed by its AUMID, which stays the same when it updates; others by exe path.
    static List<Dictionary<string, object>> Apps() {
      var apps = new List<Dictionary<string, object>>();
      var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach (var process in Process.GetProcesses()) {
        try {
          if (process.MainWindowHandle == IntPtr.Zero || String.IsNullOrEmpty(process.MainWindowTitle)) continue;
          string name, path, aumid;
          ProcessIdentity(AppProcess(process.MainWindowHandle, out name), out path, out aumid);
          if (path == "") continue;
          string description = null;
          try { description = FileVersionInfo.GetVersionInfo(path).FileDescription; } catch { }
          AddApp(apps, seen, String.IsNullOrEmpty(description) ? Path.GetFileNameWithoutExtension(path) : description, aumid != "" ? aumid : path, true);
        } catch { } finally { process.Dispose(); }
      }
      object scripting = null, shell = null;
      try {
        scripting = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        dynamic links = scripting;
        foreach (var root in new[] { Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu) }) {
          try {
            foreach (var link in Directory.EnumerateFiles(root, "*.lnk", SearchOption.AllDirectories)) {
              object shortcut = null;
              try {
                shortcut = links.CreateShortcut(link);
                string target = Convert.ToString(((dynamic)shortcut).TargetPath);
                if (target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(target)) AddApp(apps, seen, Path.GetFileNameWithoutExtension(link), target, false);
              } catch { }
              finally { if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.ReleaseComObject(shortcut); }
            }
          } catch { /* A folder the user cannot read ends that part of the list. */ }
        }
        shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
        object folder = ((dynamic)shell).NameSpace("shell:AppsFolder");
        if (folder != null) {
          try {
            object items = ((dynamic)folder).Items();
            try {
              foreach (dynamic item in (dynamic)items) {
                object entry = item;
                try { string id = Convert.ToString(item.Path); if (id.Contains("!")) AddApp(apps, seen, Convert.ToString(item.Name), id, false); } catch { }
                finally { if (entry != null && Marshal.IsComObject(entry)) Marshal.ReleaseComObject(entry); }
              }
            } finally { if (items != null && Marshal.IsComObject(items)) Marshal.ReleaseComObject(items); }
          } finally { if (Marshal.IsComObject(folder)) Marshal.ReleaseComObject(folder); }
        }
      } catch { }
      finally { if (scripting != null) Marshal.ReleaseComObject(scripting); if (shell != null) Marshal.ReleaseComObject(shell); }
      return apps;
    }
    static void AddApp(List<Dictionary<string, object>> apps, HashSet<string> seen, string name, string path, bool running) {
      if (apps.Count >= 2000 || String.IsNullOrEmpty(name) || !seen.Add(path)) return;
      apps.Add(new Dictionary<string, object> { { "name", name }, { "path", path }, { "running", running } });
    }
    static List<string> FileList() {
      var paths = new List<string>();
      if (Clipboard.ContainsFileDropList()) foreach (string file in Clipboard.GetFileDropList()) { if (paths.Count == MaxFiles) break; paths.Add(file); }
      return paths;
    }
    static bool HasBitmap(IDataObject contents) {
      return contents != null && (contents.GetDataPresent(DataFormats.Bitmap) || contents.GetDataPresent(DataFormats.Dib) || contents.GetDataPresent("PNG") || contents.GetDataPresent("image/png"));
    }
    // Password managers and other apps mark content that clipboard monitors must leave alone.
    static bool Excluded(IDataObject contents) {
      return contents != null && (contents.GetDataPresent("ExcludeClipboardContentFromMonitorProcessing") || contents.GetDataPresent("Clipboard Viewer Ignore"));
    }
    static string Optional(Dictionary<string, object> command, string key) {
      return command.ContainsKey(key) && command[key] != null ? Convert.ToString(command[key]) : null;
    }
    static string ProcessName(uint process) { using (var info = Process.GetProcessById((int)process)) return info.ProcessName.ToLowerInvariant(); }
    static void Handle(string line) {
      string id = null;
      try {
        var command = Json.Deserialize<Dictionary<string, object>>(line);
        id = Convert.ToString(command["id"]);
        string type = Convert.ToString(command["type"]);
        if (type == "settings") {
          DetectDrag = Convert.ToBoolean(command["explorerDrag"]);
          if (!DetectDrag) FinishDrag();
          if (command.ContainsKey("ownWindows")) { OwnWindows.Clear(); foreach (object window in (System.Collections.IEnumerable)command["ownWindows"]) OwnWindows.Add(Convert.ToInt64(window)); }
          Emit(new { type = "reply", id, ok = true }); return;
        }
        if (type == "sequence") { Emit(new { type = "reply", id, ok = true, sequence = GetClipboardSequenceNumber() }); return; }
        if (type == "read") {
          var contents = Clipboard.GetDataObject();
          bool owned = contents != null && Convert.ToString(contents.GetData("ClopWindows.Owner")) == ClipboardOwner;
          bool text = contents != null && contents.GetDataPresent(DataFormats.UnicodeText);
          string owner, aumid; ClipboardSource(out owner, out aumid);
          Emit(new { type = "reply", id, ok = true, sequence = GetClipboardSequenceNumber(), paths = FileList().ToArray(), bitmap = HasBitmap(contents), text, owned, transient = Excluded(contents), owner, aumid }); return;
        }
        if (type == "apps") {
          // Walking processes and the Start Menu takes a while. This thread pumps the mouse hook, which Windows drops when it
          // stalls, so the list is built on a thread of its own, STA for the shell's COM objects.
          string request = id;
          var worker = new Thread(() => {
            var json = new JavaScriptSerializer();
            try { EmitFrom(json, new { type = "reply", id = request, ok = true, apps = Apps() }); }
            catch (Exception error) { EmitFrom(json, new { type = "reply", id = request, ok = false, error = error.Message }); }
          });
          worker.IsBackground = true; worker.SetApartmentState(ApartmentState.STA); worker.Start();
          return;
        }
        if (type == "attributes") {
          // Cloud placeholders (OneDrive files-on-demand): recall on data access, recall on open, offline. Reading attributes does
          // not download them, but a network or sleeping drive can make it slow, so it runs off the mouse hook's thread too.
          string request = id;
          var paths = new List<string>();
          foreach (object item in (System.Collections.IEnumerable)command["paths"]) paths.Add(Convert.ToString(item));
          var worker = new Thread(() => {
            var cloud = new List<bool>();
            foreach (var file in paths) {
              bool placeholder = false;
              try { placeholder = ((int)File.GetAttributes(file) & 0x441000) != 0; } catch { }
              cloud.Add(placeholder);
            }
            EmitFrom(new JavaScriptSerializer(), new { type = "reply", id = request, ok = true, cloud });
          });
          worker.IsBackground = true; worker.Start();
          return;
        }
        if (type == "copy") {
          if (command.ContainsKey("expectedSequence") && Convert.ToUInt32(command["expectedSequence"]) != GetClipboardSequenceNumber()) {
            Emit(new { type = "reply", id, ok = true, skipped = true }); return;
          }
          // Any of a file list, an image (an encoded PNG, also written as a bitmap) and text.
          string file = Optional(command, "file"), png = Optional(command, "png"), text = Optional(command, "text");
          var data = new DataObject();
          data.SetData("ClopWindows.Owner", false, ClipboardOwner);
          var paths = new StringCollection();
          if (command.ContainsKey("files") && command["files"] != null) foreach (object item in (System.Collections.IEnumerable)command["files"]) paths.Add(Convert.ToString(item));
          if (paths.Count == 0 && file != null) paths.Add(file);
          if (paths.Count == 0 && png == null && String.IsNullOrEmpty(text)) throw new InvalidOperationException("There is nothing to copy.");
          if (paths.Count > 0) data.SetFileDropList(paths);
          if (!String.IsNullOrEmpty(text)) data.SetText(text, TextDataFormat.UnicodeText);
          if (png == null) Clipboard.SetDataObject(data, true, 5, 100);
          else using (var image = new Bitmap(png)) using (var stream = new MemoryStream(File.ReadAllBytes(png))) {
            data.SetImage(image);
            data.SetData("PNG", false, stream);
            Clipboard.SetDataObject(data, true, 5, 100);
          }
          Sequence = GetClipboardSequenceNumber();
          Emit(new { type = "reply", id, ok = true, sequence = Sequence }); return;
        }
        throw new InvalidOperationException("Unknown Windows bridge command.");
      } catch (Exception error) { Emit(new { type = "reply", id, ok = false, error = error.Message }); }
    }
    static IntPtr OnMouseEvent(int code, IntPtr message, IntPtr data) {
      if (code >= 0 && (message.ToInt64() == 0x0201 || message.ToInt64() == 0x0202)) {
        var mouse = (MouseData)Marshal.PtrToStructure(data, typeof(MouseData));
        var window = GetAncestor(WindowFromPoint(mouse.Point), 2);
        bool down = message.ToInt64() == 0x0201;
        if (down) {
          Bounds bounds; var origin = Point.Empty;
          // Sample this before a fast title-bar/resize gesture moves the window underneath
          // the original screen point. These calls do not message the other application.
          down = GetClientRect(window, out bounds) && ClientToScreen(window, ref origin) && mouse.Point.X >= origin.X && mouse.Point.Y >= origin.Y && mouse.Point.X < origin.X + bounds.Right && mouse.Point.Y < origin.Y + bounds.Bottom;
        }
        Presses.Enqueue(new Press { Point = mouse.Point, Window = window, Down = down });
      }
      return CallNextHookEx(IntPtr.Zero, code, message, data);
    }
    static void FinishDrag() {
      Generation++;
      Eligible = false; DragPaths = new string[0];
      if (Announced) { Announced = false; Emit(new { type = "drag-end" }); }
    }
    static void DetectImageDrag() {
      Press press;
      while (Presses.TryDequeue(out press)) {
        DragDebug("Press: down=" + press.Down + ", window=" + press.Window + ", point=" + press.Point + ", enabled=" + DetectDrag);
        FinishDrag();
        if (!DetectDrag || !press.Down || press.Window == IntPtr.Zero || OwnWindows.Contains(press.Window.ToInt64())) continue;
        Start = press.Point;
        press.Generation = Generation; Candidates.Add(press);
      }
      CheckedPress result;
      while (Checked.TryDequeue(out result)) {
        if (result.Generation != Generation || !DetectDrag) continue;
        Eligible = result.Eligible; DragPaths = result.Paths;
      }
      if (!DetectDrag) return;
      // Escape cancels a real drag even when the mouse remains held. Releasing the mouse
      // also cleans up if a source application never sends a drag-end event.
      if ((GetAsyncKeyState(1) & 0x8000) == 0 || (GetAsyncKeyState(27) & 0x8000) != 0) { FinishDrag(); return; }
      if (!Eligible) return;
      Point cursor; if (!GetCursorPos(out cursor)) return;
      int threshold = Math.Max(12, Math.Max(SystemInformation.DragSize.Width, SystemInformation.DragSize.Height));
      if (!Announced && (Math.Abs(cursor.X - Start.X) > threshold || Math.Abs(cursor.Y - Start.Y) > threshold)) {
        Announced = true; Emit(new { type = "drag-start", paths = DragPaths });
      }
    }
    static void OnDragEvent(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint thread, uint time) {
      if (eventType == 0x000F) FinishDrag();
    }
    static bool ImageAtPress(IntPtr window, Point point, out string[] paths) {
      paths = new string[0];
      // A selected image in Explorer must not make its title bar, search field, blank
      // folder space or resize handles eligible. First hit-test the actual mouse origin.
      IntPtr hit;
      var packedPoint = new IntPtr(unchecked((int)(((uint)(ushort)point.Y << 16) | (ushort)point.X)));
      var hitResult = SendMessageTimeout(window, 0x0084, IntPtr.Zero, packedPoint, 2, 100, out hit);
      DragDebug("Client hit: result=" + hitResult + ", hit=" + hit + ", explorer=" + IsExplorer(window));
      if (hitResult == IntPtr.Zero || hit.ToInt64() != 1) return false;
      if (IsExplorer(window)) return ExplorerImageAtPress(window, point, out paths);
      IAccessible accessible = null; object child;
      try {
        if (AccessibleObjectFromPoint(point, out accessible, out child) != 0 || accessible == null) return false;
        for (int depth = 0; depth < 5; depth++) {
          int role = Convert.ToInt32(accessible.get_accRole(child));
          // Editable/selectable text is never a candidate, even if its name ends in .png.
          if (role == 0x2A) return false;
          string name = accessible.get_accName(child) ?? "";
          if (role == 0x22 || role == 0x24 || role == 0x28) {
            paths = ExplorerSelection(window, name);
            if (paths.Length > 0) return true;
            if (role == 0x28 && !IsExplorer(window)) {
              string value = accessible.get_accValue(child) ?? "";
              // Image objects cover browser/native image drags. Reject a known unsupported
              // suffix; some apps only expose an image description, with no source URL.
              return SupportedGraphic(value) && SupportedGraphic(name);
            }
          }
          // Only descend from a file label/thumbnail to its containing item. Walking up
          // from an arbitrary control could mistake a whole window for an image.
          if (role != 0x29 && role != 0x28) return false;
          var parent = accessible.accParent as IAccessible;
          if (parent == null) return false;
          Marshal.ReleaseComObject(accessible); accessible = parent; child = 0;
        }
      } catch { /* Unknown/inaccessible sources stay quiet rather than guessing a drag. */ }
      finally { if (accessible != null && Marshal.IsComObject(accessible)) Marshal.ReleaseComObject(accessible); }
      return false;
    }
    static bool ExplorerImageAtPress(IntPtr window, Point point, out string[] paths) {
      paths = new string[0];
      try {
        // Modern Explorer exposes its file view through UI Automation, including items
        // whose legacy MSAA hit test only returns the containing pane.
        var element = AutomationElement.FromPoint(new System.Windows.Point(point.X, point.Y));
        for (int depth = 0; element != null && depth < 5; depth++) {
          var info = element.Current;
          DragDebug("Explorer hit: " + info.ControlType.ProgrammaticName + " / " + info.Name);
          if (info.ControlType == ControlType.Edit || info.ControlType == ControlType.ComboBox) return false;
          if (info.ControlType == ControlType.ListItem || info.ControlType == ControlType.DataItem) {
            paths = ExplorerSelection(window, info.Name);
            DragDebug("Explorer image matches: " + String.Join(", ", paths));
            return paths.Length > 0;
          }
          if (info.ControlType != ControlType.Text && info.ControlType != ControlType.Image && info.ControlType != ControlType.Custom && info.ControlType != ControlType.Pane) return false;
          element = TreeWalker.ControlViewWalker.GetParent(element);
        }
      } catch { /* A disappeared or inaccessible item cannot authorise a drag. */ }
      return false;
    }
    static bool SupportedGraphic(string value) {
      Uri uri;
      if (Uri.TryCreate(value, UriKind.Absolute, out uri)) {
        if (uri.Scheme == "data") return value.StartsWith("data:image/png", StringComparison.OrdinalIgnoreCase) || value.StartsWith("data:image/jpeg", StringComparison.OrdinalIgnoreCase) || value.StartsWith("data:image/webp", StringComparison.OrdinalIgnoreCase) || value.StartsWith("data:image/gif", StringComparison.OrdinalIgnoreCase) || value.StartsWith("data:image/avif", StringComparison.OrdinalIgnoreCase);
        value = uri.AbsolutePath;
      }
      string extension = Path.GetExtension(value);
      return String.IsNullOrEmpty(extension) || Extensions.Contains(extension);
    }
    static bool IsExplorer(IntPtr window) {
      uint process; GetWindowThreadProcessId(window, out process);
      try { return String.Equals(Process.GetProcessById((int)process).ProcessName, "explorer", StringComparison.OrdinalIgnoreCase); } catch { return false; }
    }
    static bool ItemNameMatches(string name, string file, string displayName) {
      return String.Equals(name, displayName, StringComparison.OrdinalIgnoreCase) || String.Equals(name, Path.GetFileName(file), StringComparison.OrdinalIgnoreCase) || String.Equals(name, Path.GetFileNameWithoutExtension(file), StringComparison.OrdinalIgnoreCase);
    }
    static string[] ExplorerSelection(IntPtr window, string name) {
      var paths = new List<string>();
      if (!IsExplorer(window) || String.IsNullOrEmpty(name)) return paths.ToArray();
      bool hitSelectedImage = false;
      object shell = null, windows = null;
      try {
        shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
        dynamic automation = shell; windows = automation.Windows();
        foreach (dynamic explorer in (dynamic)windows) {
          try {
            if ((long)explorer.HWND != window.ToInt64()) continue;
            foreach (dynamic item in explorer.Document.SelectedItems()) {
              string file = Convert.ToString(item.Path);
              if (MediaExtensions.Contains(Path.GetExtension(file)) && File.Exists(file)) {
                paths.Add(file);
                if (ItemNameMatches(name, file, Convert.ToString(item.Name))) hitSelectedImage = true;
              }
            }
          } catch { }
        }
      } catch { }
      finally { if (windows != null) Marshal.ReleaseComObject(windows); if (shell != null) Marshal.ReleaseComObject(shell); }
      if (hitSelectedImage) return paths.ToArray();
      // The desktop is an Explorer list but is not returned by Shell.Application.Windows().
      var className = new StringBuilder(256); GetClassName(window, className, className.Capacity);
      if (className.ToString() == "Progman" || className.ToString() == "WorkerW") {
        foreach (var directory in new[] { Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory) }) {
          try { foreach (var file in Directory.EnumerateFiles(directory)) if (MediaExtensions.Contains(Path.GetExtension(file)) && ItemNameMatches(name, file, Path.GetFileName(file))) return new[] { file }; } catch { }
        }
      }
      return new string[0];
    }
  }
}
