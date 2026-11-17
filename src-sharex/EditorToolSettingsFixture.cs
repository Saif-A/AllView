// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Drawing;
using System.IO;
using ShareX.ScreenCaptureLib;

namespace AllView.Editor;

internal static class EditorToolSettingsFixture
{
    internal static string Run(string directory)
    {
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, "editor-tools.json");
        var settings = new EditorToolSettings(path);
        using (var first = settings.CreateEditor(new Bitmap(32, 24)))
        {
            _ = first.Handle;
            var options = first.Options;
            options.LastEditorTool = ShapeType.EffectPixelate;
            options.AnnotationOptions.BorderColor = Color.FromArgb(171, 20, 40, 60);
            options.AnnotationOptions.BorderSize = 9;
            options.AnnotationOptions.FillColor = Color.FromArgb(80, 90, 100);
            options.AnnotationOptions.BlurRadius = 71;
            options.AnnotationOptions.PixelateSize = 24;
            options.AnnotationOptions.HighlightColor = Color.Cyan;
            options.AnnotationOptions.TextOptions.Font = "Tahoma";
            options.AnnotationOptions.TextOptions.Size = 23;
            options.AnnotationOptions.TextOptions.Bold = true;
            options.AnnotationOptions.LastImageFilePath = "private-image.png";
            options.AnnotationOptions.LastStickerPath = "private-sticker.png";
            first.HostAbort();
        }
        using (var reopened = new EditorToolSettings(path).CreateEditor(new Bitmap(32, 24)))
        {
            var tools = reopened.Options.AnnotationOptions;
            Assert(reopened.HostCurrentTool == ShapeType.EffectPixelate, "last tool was not restored");
            Assert(tools.BorderColor.ToArgb() == Color.FromArgb(171, 20, 40, 60).ToArgb()
                && tools.BorderSize == 9 && tools.FillColor.ToArgb() == Color.FromArgb(80, 90, 100).ToArgb(), "drawing styles were not restored");
            Assert(tools.BlurRadius == 71 && tools.PixelateSize == 24
                && tools.HighlightColor.ToArgb() == Color.Cyan.ToArgb(), "effect options were not restored");
            Assert(tools.TextOptions.Font == "Tahoma" && tools.TextOptions.Size == 23
                && tools.TextOptions.Bold, "font options were not restored");
            Assert(!reopened.Options.EditorAutoCopyImage, "opening the editor enabled automatic output");
        }
        string previous = File.ReadAllText(path);
        Assert(!previous.Contains("private-image") && !previous.Contains("private-sticker"), "image paths entered preferences");
        using (var locked = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            Assert(!settings.TrySave(new RegionCaptureOptions()), "locked preferences should reject replacement");
        Assert(File.ReadAllText(path) == previous, "failed write damaged previous preferences");
        Assert(Directory.GetFiles(directory, "*.tmp").Length == 0, "failed write retained temporary output");
        File.WriteAllText(path, "{broken");
        Assert(settings.Load().AnnotationOptions.BlurRadius == 35, "corrupt preferences did not recover");
        File.WriteAllText(path, "{\"Version\":1,\"Tools\":{\"TextOptions\":null}}");
        Assert(settings.Load().AnnotationOptions.TextOptions != null, "invalid nested preferences did not recover");
        File.WriteAllText(path, "{\"Version\":1,\"Tools\":{\"BlurRadius\":-10}}");
        Assert(settings.Load().AnnotationOptions.BlurRadius == 35, "invalid option range did not recover");
        File.WriteAllText(path, new string(' ', 65537));
        Assert(settings.Load().LastEditorTool == ShapeType.DrawingRectangle, "oversized preferences did not recover");
        return "editor close/reopen and disk reload preserve tool, colors, widths, fonts and effects; invalid/oversized preferences recover; failed replacement preserves previous settings";
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
