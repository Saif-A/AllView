// SPDX-License-Identifier: GPL-3.0-or-later
// Adapter compiled into the pinned ShareX library; upstream tool behavior stays upstream.
using System;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace ShareX.ScreenCaptureLib
{
    public sealed partial class RegionCaptureForm
    {
        public bool HostOutputSucceeded = true;
        public bool HostFixtureMode = false;
        public ShapeType HostCurrentTool => ShapeManager.CurrentTool;
        public event Func<Bitmap, bool> HostCopyAndCloseRequested;
        public void HostAbort() { forceClose = true; CloseWindow(RegionResult.Close); }
        public void HostAssertBranding()
        {
            if (!Text.Contains("All View") || Text.Contains("ShareX")) throw new Exception("Editor branding is incorrect.");
        }
        public string HostToolbarLabels() { HostFixtureMode = true; ShapeManager.CreateToolbar(); HostPrepareToolbar(); return ShapeManager.HostToolbarLabels(); }

        public void HostCopyAndClose()
        {
            using (Bitmap image = GetResultImage())
            {
                if (image != null && HostCopyAndCloseRequested?.Invoke(image) == true)
                {
                    ShapeManager.IsImageModified = false;
                    forceClose = true;
                    CloseWindow(RegionResult.Close);
                }
            }
        }

        public void HostPrepareToolbar()
        {
            ShapeManager.HostPrepareToolbar();
        }

        public string HostFixtureChecks()
        {
            if (!GetStyle(ControlStyles.OptimizedDoubleBuffer)) throw new Exception("Capture buffering is disabled.");
            var blur = new BlurEffectShape { Rectangle = new RectangleF(8, 8, 32, 24), BlurRadius = 3, Manager = ShapeManager };
            ShapeManager.Shapes.Add(blur);
            using (var first = ShapeManager.RenderOutputImage(Canvas))
            {
                blur.BlurRadius = 12;
                blur.Rectangle = new RectangleF(20, 12, 40, 30);
                using (var second = ShapeManager.RenderOutputImage(Canvas))
                {
                    if (ShapeManager.Shapes.Count != 1 || !ReferenceEquals(ShapeManager.Shapes[0], blur))
                        throw new Exception("Effect was flattened.");
                    if (first.GetPixel(12, 12) == second.GetPixel(12, 12)) throw new Exception("Effect edit did not change pixels.");
                }
            }
            ShapeManager.IsImageModified = true;
            SaveImageRequested += (output, path) => { output.Dispose(); HostOutputSucceeded = false; return null; };
            OnSaveImageRequested();
            if (!ShapeManager.IsImageModified) throw new Exception("Failed save cleared edits.");
            SaveImageAsRequested += (output, path) => { output.Dispose(); HostOutputSucceeded = false; return null; };
            OnSaveImageAsRequested();
            if (!ShapeManager.IsImageModified) throw new Exception("Cancelled Save as cleared edits.");
            HostCopyAndCloseRequested += output => false;
            HostCopyAndClose();
            if (IsDisposed || !ShapeManager.IsImageModified) throw new Exception("Failed Copy and close discarded edits.");
            return "double-buffering; editable blur radius and geometry; upstream rendering; failed Save/cancelled Save as/failed Copy and close preserve edits";
        }

        public string HostRenderFixture(string directory)
        {
            HostFixtureMode = true;
            ShapeManager.CreateToolbar();
            HostPrepareToolbar();
            return ShapeManager.HostRenderFixture(directory);
        }
    }

    internal partial class ShapeManager
    {
        internal string HostToolbarLabels()
        {
            if (!menuForm.Text.Contains("All View") || menuForm.Text.Contains("ShareX")) throw new Exception("Floating editor toolbar branding is incorrect.");
            return string.Join("; ", tsMain.Items.OfType<ToolStripItem>().Where(item => !string.IsNullOrWhiteSpace(item.Text)).Select(item => item.Text));
        }
        internal void HostPrepareToolbar()
        {
            foreach (ToolStripItem item in tsMain.Items)
                if (item.Text == Properties.Resources.ShapeManager_CreateToolbar_UploadImage) item.Enabled = false;
        }

        internal string HostRenderFixture(string directory)
        {
            var labels = tsMain.Items.OfType<ToolStripItem>().Where(item => !string.IsNullOrWhiteSpace(item.Text)).Select(item => item.Text).ToArray();
            if (!labels.Contains("Copy and close (Enter)") || !labels.Contains(Properties.Resources.ShapeManager_CreateToolbar_SaveImage) || !labels.Contains(Properties.Resources.ShapeManager_CreateToolbar_SaveImageAs))
                throw new Exception("Required output toolbar buttons are missing.");
            using (var bitmap = new Bitmap(tsMain.Width, tsMain.Height))
            {
                tsMain.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                bitmap.Save(System.IO.Path.Combine(directory, "sharex-toolbar.png"));
            }
            using (var bitmap = RenderOutputImage(Form.Canvas)) bitmap.Save(System.IO.Path.Combine(directory, "sharex-editable-effect.png"));
            return string.Join("; ", labels);
        }
    }
}
