param(
    [string]$InputPath = (Join-Path $PSScriptRoot '..\android\app\icon-source\reader-icon-cat.png'),
    [string]$ResourceRoot = (Join-Path $PSScriptRoot '..\android\app\src\main\res')
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

if (-not ('ReaderIconGenerator' -as [type])) {
    Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class ReaderIconGenerator
{
    private const int MatteThreshold = 245;
    private const int MatteBlackLevel = 2;
    private const int MatteOpaqueLevel = 248;

    public static void Generate(string inputPath, string resourceRoot)
    {
        using (var source = new Bitmap(inputPath))
        using (var icon = CreateTransparentIcon(source))
        {
            WriteDensity(icon, resourceRoot, "mdpi", 48);
            WriteDensity(icon, resourceRoot, "hdpi", 72);
            WriteDensity(icon, resourceRoot, "xhdpi", 96);
            WriteDensity(icon, resourceRoot, "xxhdpi", 144);
            WriteDensity(icon, resourceRoot, "xxxhdpi", 192);
        }
    }

    private static Bitmap CreateTransparentIcon(Bitmap source)
    {
        var result = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
        result.SetResolution(source.HorizontalResolution, source.VerticalResolution);

        using (var graphics = Graphics.FromImage(result))
        {
            graphics.CompositingMode = CompositingMode.SourceCopy;
            graphics.DrawImageUnscaled(source, 0, 0);
        }

        var rect = new Rectangle(0, 0, result.Width, result.Height);
        var data = result.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);

        try
        {
            int stride = data.Stride;
            int byteCount = Math.Abs(stride) * result.Height;
            var pixels = new byte[byteCount];
            Marshal.Copy(data.Scan0, pixels, 0, byteCount);

            int width = result.Width;
            int height = result.Height;
            var connectedMatte = new bool[width * height];
            var queue = new Queue<int>();

            for (int x = 0; x < width; x++)
            {
                EnqueueIfMatte(x, 0, width, height, stride, pixels, connectedMatte, queue);
                EnqueueIfMatte(x, height - 1, width, height, stride, pixels, connectedMatte, queue);
            }

            for (int y = 1; y < height - 1; y++)
            {
                EnqueueIfMatte(0, y, width, height, stride, pixels, connectedMatte, queue);
                EnqueueIfMatte(width - 1, y, width, height, stride, pixels, connectedMatte, queue);
            }

            while (queue.Count > 0)
            {
                int position = queue.Dequeue();
                int x = position % width;
                int y = position / width;

                EnqueueIfMatte(x - 1, y, width, height, stride, pixels, connectedMatte, queue);
                EnqueueIfMatte(x + 1, y, width, height, stride, pixels, connectedMatte, queue);
                EnqueueIfMatte(x, y - 1, width, height, stride, pixels, connectedMatte, queue);
                EnqueueIfMatte(x, y + 1, width, height, stride, pixels, connectedMatte, queue);
            }

            for (int position = 0; position < connectedMatte.Length; position++)
            {
                if (!connectedMatte[position])
                    continue;

                int x = position % width;
                int y = position / width;
                int offset = y * stride + x * 4;
                int blue = pixels[offset];
                int green = pixels[offset + 1];
                int red = pixels[offset + 2];
                int luminance = Luminance(red, green, blue);

                int alpha = (luminance - MatteBlackLevel) * 255 /
                    (MatteOpaqueLevel - MatteBlackLevel);
                alpha = Math.Max(0, Math.Min(255, alpha));

                if (alpha == 0)
                {
                    pixels[offset] = 255;
                    pixels[offset + 1] = 255;
                    pixels[offset + 2] = 255;
                    pixels[offset + 3] = 0;
                    continue;
                }

                pixels[offset] = (byte)Math.Min(255, blue * 255 / alpha);
                pixels[offset + 1] = (byte)Math.Min(255, green * 255 / alpha);
                pixels[offset + 2] = (byte)Math.Min(255, red * 255 / alpha);
                pixels[offset + 3] = (byte)alpha;
            }

            Marshal.Copy(pixels, 0, data.Scan0, byteCount);
        }
        finally
        {
            result.UnlockBits(data);
        }

        return result;
    }

    private static void EnqueueIfMatte(
        int x,
        int y,
        int width,
        int height,
        int stride,
        byte[] pixels,
        bool[] connectedMatte,
        Queue<int> queue)
    {
        if (x < 0 || y < 0 || x >= width || y >= height)
            return;

        int position = y * width + x;
        if (connectedMatte[position])
            return;

        int offset = y * stride + x * 4;
        int luminance = Luminance(pixels[offset + 2], pixels[offset + 1], pixels[offset]);
        if (luminance > MatteThreshold)
            return;

        connectedMatte[position] = true;
        queue.Enqueue(position);
    }

    private static int Luminance(int red, int green, int blue)
    {
        return (54 * red + 183 * green + 19 * blue) >> 8;
    }

    private static void WriteDensity(Bitmap source, string resourceRoot, string density, int size)
    {
        string directory = Path.Combine(resourceRoot, "drawable-" + density);
        Directory.CreateDirectory(directory);
        string outputPath = Path.Combine(directory, "reader_icon.png");

        using (var resized = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(resized))
        using (var attributes = new ImageAttributes())
        {
            resized.SetResolution(96, 96);
            graphics.CompositingMode = CompositingMode.SourceCopy;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.SmoothingMode = SmoothingMode.HighQuality;
            attributes.SetWrapMode(WrapMode.TileFlipXY);
            graphics.DrawImage(
                source,
                new Rectangle(0, 0, size, size),
                0,
                0,
                source.Width,
                source.Height,
                GraphicsUnit.Pixel,
                attributes);
            resized.Save(outputPath, ImageFormat.Png);
        }
    }
}
'@
}

$resolvedInput = [System.IO.Path]::GetFullPath($InputPath)
$resolvedResourceRoot = [System.IO.Path]::GetFullPath($ResourceRoot)

if (-not (Test-Path -LiteralPath $resolvedInput -PathType Leaf)) {
    throw "Input image not found: $resolvedInput"
}

[ReaderIconGenerator]::Generate($resolvedInput, $resolvedResourceRoot)
Write-Host "Android launcher icons generated from $resolvedInput"
