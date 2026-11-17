// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using ShareX.ScreenCaptureLib;

namespace AllView.Editor;

internal sealed class EditorToolSettings
{
    private const int MaximumBytes = 64 * 1024;
    private readonly string path;
    private static readonly JsonSerializerSettings JsonSettings = new()
    {
        ContractResolver = new ToolContractResolver(),
        TypeNameHandling = TypeNameHandling.None,
        MaxDepth = 16,
        Formatting = Formatting.Indented
    };

    internal EditorToolSettings(string path) => this.path = path;

    internal static EditorToolSettings ForCurrentUser() => new(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "All View", "editor-tools.json"));

    internal RegionCaptureOptions Load()
    {
        var options = new RegionCaptureOptions
        {
            ZoomToFitOnOpen = true,
            ShowEditorPanTip = false,
            InputDelay = 0
        };
        try
        {
            using var input = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (input.Length > MaximumBytes) return options;
            using var reader = new StreamReader(input, Encoding.UTF8);
            var saved = JsonConvert.DeserializeObject<Snapshot>(reader.ReadToEnd(), JsonSettings);
            if (saved?.Version == 1 && IsValid(saved))
            {
                options.AnnotationOptions = saved.Tools;
                options.LastEditorTool = saved.LastTool;
            }
        }
        catch (Exception error) when (IsStorageError(error)) { }
        return options;
    }

    internal bool TrySave(RegionCaptureOptions options)
    {
        string temporaryPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            var saved = new Snapshot { Tools = options.AnnotationOptions, LastTool = options.LastEditorTool };
            if (!IsValid(saved)) return false;
            byte[] bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(saved, JsonSettings));
            if (bytes.Length > MaximumBytes) return false;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using (var output = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                output.Write(bytes);
                output.Flush(true);
            }
            File.Move(temporaryPath, path, true);
            return true;
        }
        catch (Exception error) when (IsStorageError(error)) { return false; }
        finally
        {
            try { File.Delete(temporaryPath); }
            catch (Exception error) when (IsStorageError(error)) { }
        }
    }

    internal RegionCaptureForm CreateEditor(Bitmap image)
    {
        var form = new RegionCaptureForm(RegionCaptureMode.Editor, Load(), image);
        form.FormClosed += (_, _) =>
        {
            if (!TrySave(form.Options))
                MessageBox.Show("All View could not save the image editor tool options. Check access to your local application data folder.",
                    "All View image editor", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        };
        return form;
    }

    private static bool IsStorageError(Exception error) => error is IOException or UnauthorizedAccessException
        or System.Security.SecurityException or JsonException or ArgumentException or NotSupportedException;

    private static bool InRange(int value, int minimum, int maximum) => value >= minimum && value <= maximum;

    private static bool ValidText(TextDrawingOptions? text) => text != null
        && !string.IsNullOrWhiteSpace(text.Font) && text.Font.Length <= 128
        && InRange(text.Size, 1, 1000)
        && Enum.IsDefined(text.AlignmentHorizontal) && Enum.IsDefined(text.AlignmentVertical)
        && Enum.IsDefined(text.GradientMode);

    private static bool IsValid(Snapshot saved)
    {
        var tools = saved.Tools;
        return tools != null && Enum.IsDefined(saved.LastTool) && saved.LastTool >= ShapeType.ToolSelect
            && InRange(tools.RegionCornerRadius, 0, 150) && InRange(tools.DrawingCornerRadius, 0, 150)
            && InRange(tools.BorderSize, 0, 20) && InRange(tools.TextBorderSize, 0, 20)
            && InRange(tools.TextOutlineBorderSize, 0, 20) && InRange(tools.StepBorderSize, 0, 20)
            && InRange(tools.StepFontSize, 10, 300) && InRange(tools.LineCenterPointCount, 0, LineDrawingShape.MaximumCenterPointCount)
            && InRange(tools.MagnifyStrength, 100, 1000) && InRange(tools.StickerSize, 1, 10000)
            && InRange(tools.BlurRadius, 3, 199) && InRange(tools.PixelateSize, 2, 10000)
            && InRange(tools.CutOutEffectSize, 3, 100)
            && InRange(tools.ShadowOffset.X, -1000, 1000) && InRange(tools.ShadowOffset.Y, -1000, 1000)
            && Enum.IsDefined(tools.BorderStyle) && Enum.IsDefined(tools.ArrowHeadDirection)
            && Enum.IsDefined(tools.ImageInterpolationMode) && Enum.IsDefined(tools.StepType)
            && Enum.IsDefined(tools.CutOutEffectType)
            && ValidText(tools.TextOptions) && ValidText(tools.TextOutlineOptions);
    }

    private sealed class Snapshot
    {
        public int Version { get; set; } = 1;
        public ShapeType LastTool { get; set; } = ShapeType.DrawingRectangle;
        public AnnotationOptions Tools { get; set; } = new();
    }

    private sealed class ToolContractResolver : DefaultContractResolver
    {
        protected override IList<JsonProperty> CreateProperties(Type type, MemberSerialization serialization)
        {
            return base.CreateProperties(type, serialization)
                .Where(property => property.Readable && property.Writable
                    && property.PropertyName is not (nameof(AnnotationOptions.LastImageFilePath)
                        or nameof(AnnotationOptions.LastStickerPath) or nameof(AnnotationOptions.StickerPacks)
                        or nameof(AnnotationOptions.SelectedStickerPack)))
                .ToList();
        }
    }
}
