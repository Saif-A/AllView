// SPDX-License-Identifier: GPL-3.0-or-later
// In-process adapter for the pinned editor. Native code owns file/clipboard authority.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Printing;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;
using ShareX.HelpersLib;
using ShareX.ScreenCaptureLib;

namespace AllView.Editor;
public static unsafe class Entry
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Request
    {
        public int Version, HeaderLength;
        public byte* Header;
        public int ImageLength;
        public byte* Image;
        public void* Context;
        public delegate* unmanaged[Cdecl]<void*, byte*, int, byte*, int, byte*, int, int> Send;
    }
    private static int busy;
    private static bool initialized;
    [UnmanagedCallersOnly]
    public static int Run(void* argument, int size)
    {
        if (size != sizeof(Request) || argument == null) return -1;
        Request request = *(Request*)argument;
        if (request.Version != 1 || request.Send == null || request.Header == null || request.HeaderLength < 2 || request.HeaderLength > 16384 || request.ImageLength < 0 || request.ImageLength > 64 * 1024 * 1024 || request.ImageLength > 0 && request.Image == null) return -2;
        if (Interlocked.CompareExchange(ref busy, 1, 0) != 0) return -3;
        try
        {
            byte[] header = new ReadOnlySpan<byte>(request.Header, request.HeaderLength).ToArray();
            byte[] image = new ReadOnlySpan<byte>(request.Image, request.ImageLength).ToArray();
            var session = new Session(request);
            var thread = new Thread(() =>
            {
                try
                {
                    // Tauri owns process-wide DPI and its main loop; only this new STA gets a context.
                    SetThreadDpiAwarenessContext(new IntPtr(-4));
                    if (!initialized) {
                        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                        ShareXResources.Name = "All View";
                        var icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
                        if (icon != null) { ShareXResources.Icon = icon; ShareXResources.Logo = icon.ToBitmap(); }
                        initialized = true;
                    }
                    session.Run(header, image);
                }
                catch (Exception error) { session.Error(error.Message); }
                finally { session.Dispose(); }
            }) { IsBackground = true, Name = "All View image editor" };
            thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
            return 0;
        }
        catch { return -4; }
        finally { Volatile.Write(ref busy, 0); }
    }
    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    private sealed class Session : IDisposable
    {
        private readonly Request native;
        private RegionCaptureForm? editor;
        private System.Windows.Forms.Timer? cancellation;
        private string outputFormat = "png";
        private bool cancelled;
        public Session(Request native) { this.native = native; }
        private JsonDocument Send(object header, byte[]? image = null)
        {
            image ??= Array.Empty<byte>();
            byte[] json = JsonSerializer.SerializeToUtf8Bytes(header), reply = new byte[16384];
            if (json.Length > 16384 || image.Length > 64 * 1024 * 1024) throw new InvalidDataException("Editor message exceeds its limit.");
            fixed (byte* h = json, b = image, r = reply)
            {
                int length = native.Send(native.Context, h, json.Length, b, image.Length, r, reply.Length);
                if (length < 2 || length > reply.Length) throw new IOException("Invalid editor acknowledgement.");
                return JsonDocument.Parse(reply.AsMemory(0, length));
            }
        }
        public void Error(string message) { try { using var ignored = Send(new { action = "error", error = message }); } catch { } }
        private bool Check()
        {
            if (cancelled) return false;
            using var reply = Send(new { action = "check" });
            if (reply.RootElement.GetProperty("ok").GetBoolean()) return true;
            cancelled = true; editor?.HostAbort(); return false;
        }
        private void Watch(RegionCaptureForm form)
        {
            editor = form; cancellation = new System.Windows.Forms.Timer { Interval = 100 };
            cancellation.Tick += (_, _) => { try { Check(); } catch { cancelled = true; form.HostAbort(); } }; cancellation.Start();
        }
        private static byte[] Encode(Bitmap image, string format)
        {
            if ((long)image.Width * image.Height > 16000000) throw new InvalidDataException("Images are limited to 16 megapixels.");
            using var stream = new MemoryStream(); image.Save(stream, format == "jpg" ? ImageFormat.Jpeg : ImageFormat.Png);
            if (stream.Length > 64 * 1024 * 1024) throw new InvalidDataException("Image exceeds 64 MiB."); return stream.ToArray();
        }
        private string? Output(string action, Bitmap image)
        {
            try
            {
                if (!Check()) return null;
                string format = action == "save" ? outputFormat : "png";
                using var reply = Send(new { action, format }, Encode(image, format)); var value = reply.RootElement;
                if (!value.GetProperty("ok").GetBoolean()) throw new IOException(value.GetProperty("error").GetString());
                if (value.TryGetProperty("cancelled", out var c) && c.GetBoolean()) { editor!.HostOutputSucceeded = false; return null; }
                if (value.TryGetProperty("format", out var f)) outputFormat = f.GetString() ?? "png";
                editor!.HostOutputSucceeded = true; return value.TryGetProperty("path", out var p) ? p.GetString() : "Copied";
            }
            catch (Exception error)
            {
                if (editor != null) editor.HostOutputSucceeded = false;
                if (!cancelled) MessageBox.Show(editor, error.Message, "All View image editor", MessageBoxButtons.OK, MessageBoxIcon.Error); return null;
            }
        }
        private static Icon? AppIcon() => Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
        public void Run(byte[] header, byte[] bytes)
        {
            using var document = JsonDocument.Parse(header); var value = document.RootElement;
            using var ready = Send(new { action = "ready", pid = Environment.ProcessId }); if (!Check()) return;
            switch (value.GetProperty("mode").GetString())
            {
                case "capture": Capture(); break;
                case "edit": Edit(value, bytes); break;
                case "self-test": Fixture(); break;
                case "cancel-test": CancellationFixture(); break;
                case "preferences-test":
                    string details = EditorToolSettingsFixture.Run(value.GetProperty("directory").GetString()!);
                    using (var result = Send(new { action = "preferences-fixture", details })) { }
                    break;
                default: throw new InvalidDataException("Unknown editor mode.");
            }
        }
        private void Edit(JsonElement header, byte[] bytes)
        {
            using var stream = new MemoryStream(bytes); using var source = Image.FromStream(stream);
            if ((long)source.Width * source.Height > 16000000) throw new InvalidDataException("Images are limited to 16 megapixels.");
            outputFormat = header.GetProperty("format").GetString() ?? "png";
            ShareXResources.Theme = header.TryGetProperty("light", out var light) && light.GetBoolean() ? ShareXTheme.LightTheme : ShareXTheme.DarkTheme;
            using var form = EditorToolSettings.ForCurrentUser().CreateEditor(new Bitmap(source));
            using var icon = AppIcon(); if (icon != null) form.Icon = icon;
            form.ImageFilePath = header.GetProperty("name").GetString() ?? "Image.png";
            form.SaveImageRequested += (output, _) => { using (output) return Output("save", output); };
            form.SaveImageAsRequested += (output, _) => { using (output) return Output("save-as", output); };
            form.CopyImageRequested += output => Output("copy", output); form.HostCopyAndCloseRequested += output => Output("copy", output) != null;
            form.PrintImageRequested += output => { using (output) Print(output); };
            form.KeyDown += (_, e) => { if (e.KeyData == Keys.Enter) { e.Handled = true; e.SuppressKeyPress = true; } };
            form.Shown += (_, _) => form.HostPrepareToolbar(); Watch(form); if (Check()) form.ShowDialog();
            using var closed = Send(new { action = "closed" });
        }
        private void Capture()
        {
            var bounds = SystemInformation.VirtualScreen;
            if ((long)bounds.Width * bounds.Height > 40000000) throw new InvalidDataException("Desktop capture exceeds 40 megapixels.");
            using var form = new RegionCaptureForm(RegionCaptureMode.Default, new RegionCaptureOptions { DetectWindows = true, DetectControls = true, InputDelay = 0, FPSLimit = 60 });
            using var icon = AppIcon(); if (icon != null) form.Icon = icon;
            bool closing = false, focusChanged = false;
            form.FormClosing += (_, _) => closing = true;
            form.Deactivate += (_, _) => { if (!closing && form.Result == RegionResult.Close) { focusChanged = true; form.HostAbort(); } };
            Watch(form); if (Check()) form.ShowDialog(); using var image = cancelled ? null : form.GetResultImage();
            using var result = Send(new { action = image == null ? "cancelled" : "captured", focusChanged }, image == null ? null : Encode(image, "png"));
        }
        private void Print(Bitmap image)
        {
            using var document = new PrintDocument(); document.PrintPage += (_, e) => { var area = e.MarginBounds; float f = Math.Min((float)area.Width / image.Width, (float)area.Height / image.Height); e.Graphics!.DrawImage(image, area.X, area.Y, image.Width * f, image.Height * f); };
            using var dialog = new PrintDialog { Document = document, UseEXDialog = true }; if (dialog.ShowDialog(editor) == DialogResult.OK) document.Print();
        }
        private void Fixture()
        {
            using var image = new Bitmap(96, 72);
            for (int y = 0; y < image.Height; y++) for (int x = 0; x < image.Width; x++) image.SetPixel(x, y, (x + y) % 3 == 0 ? Color.White : Color.Black);
            using var form = new RegionCaptureForm(RegionCaptureMode.Editor, new RegionCaptureOptions { DetectWindows = false }, new Bitmap(image));
            var details = form.HostFixtureChecks(); form.HostAssertBranding();
            using var result = Send(new { action = "fixture", pid = Environment.ProcessId, details, title = form.Text, tools = form.HostToolbarLabels() }); form.HostAbort();
        }
        private void CancellationFixture()
        {
            using var image = new Bitmap(96, 72);
            using var form = new RegionCaptureForm(RegionCaptureMode.Editor, new RegionCaptureOptions { DetectWindows = false }, new Bitmap(image));
            _ = form.Handle; // Create a hidden window to exercise the real STA timer/Close path.
            Watch(form); var deadline = DateTime.UtcNow.AddSeconds(3);
            while (!cancelled && DateTime.UtcNow < deadline) { Application.DoEvents(); Thread.Sleep(5); }
            if (!cancelled || !form.IsDisposed) throw new Exception("Stale editor cancellation did not dispose its hidden form.");
            using var result = Send(new { action = "cancelled-fixture", pid = Environment.ProcessId });
        }
        public void Dispose() { cancellation?.Stop(); cancellation?.Dispose(); editor = null; }
    }
}
