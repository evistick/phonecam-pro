// vcam-feed.cs — PhoneCam Pro virtual camera feeder
// Creates the OBSVirtualCamVideo shared memory queue (same protocol as
// OBS / pyvirtualcam) and writes NV12 frames received from stdin.
// Compile (x64): csc /platform:x64 /optimize+ /out:vcam-feed.exe vcam-feed.cs
using System;
using System.IO;
using System.Runtime.InteropServices;

class VcamFeed
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileMappingW(IntPtr hFile, IntPtr lpAttributes, uint flProtect,
        uint dwMaximumSizeHigh, uint dwMaximumSizeLow, string lpName);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr OpenFileMappingW(uint dwDesiredAccess, bool bInheritHandle, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr MapViewOfFile(IntPtr hFileMappingObject, uint dwDesiredAccess,
        uint dwFileOffsetHigh, uint dwFileOffsetLow, UIntPtr dwNumberOfBytesToMap);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UnmapViewOfFile(IntPtr lpBaseAddress);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    static extern bool QueryPerformanceCounter(out long lpPerformanceCount);

    [DllImport("kernel32.dll")]
    static extern bool QueryPerformanceFrequency(out long lpFrequency);

    const uint PAGE_READWRITE = 0x04;
    const uint FILE_MAP_READ = 0x0004;
    const uint FILE_MAP_ALL_ACCESS = 0xF001F;
    const int FRAME_HEADER_SIZE = 32;

    const uint STATE_STARTING = 1;
    const uint STATE_READY = 2;
    const uint STATE_STOPPING = 3;

    // Layout must match MSVC x64 packing of the OBS queue_header struct.
    [StructLayout(LayoutKind.Explicit)]
    struct QueueHeader
    {
        [FieldOffset(0)] public uint write_idx;
        [FieldOffset(4)] public uint read_idx;
        [FieldOffset(8)] public uint state;
        [FieldOffset(12)] public uint offsets0;
        [FieldOffset(16)] public uint offsets1;
        [FieldOffset(20)] public uint offsets2;
        [FieldOffset(24)] public uint type;
        [FieldOffset(28)] public uint cx;
        [FieldOffset(32)] public uint cy;
        [FieldOffset(40)] public ulong interval;
    }

    static IntPtr mapping = IntPtr.Zero;
    static IntPtr view = IntPtr.Zero;
    static long freq;
    static long startTicks;
    static int cx, cy, frameSize;
    static int off0, off1, off2;

    static ulong NowNs()
    {
        long t;
        QueryPerformanceCounter(out t);
        return (ulong)(((double)(t - startTicks) * 1000000000.0) / freq);
    }

    static void Cleanup()
    {
        try
        {
            if (view != IntPtr.Zero)
            {
                Marshal.WriteInt32(view, 8, (int)STATE_STOPPING);
                UnmapViewOfFile(view);
                view = IntPtr.Zero;
            }
            if (mapping != IntPtr.Zero)
            {
                CloseHandle(mapping);
                mapping = IntPtr.Zero;
            }
        }
        catch { }
    }

    static void WriteFrame(byte[] frame, uint inc)
    {
        uint idx = inc % 3;
        IntPtr slot = IntPtr.Add(view, idx == 0 ? off0 : (idx == 1 ? off1 : off2));
        Marshal.WriteInt64(slot, 0, (long)NowNs());
        Marshal.Copy(frame, 0, IntPtr.Add(slot, FRAME_HEADER_SIZE), frameSize);
        Marshal.WriteInt32(view, 0, (int)inc);
        Marshal.WriteInt32(view, 4, (int)inc);
        Marshal.WriteInt32(view, 8, (int)STATE_READY);
    }

    static void RunTestPattern(int fps)
    {
        byte[] nv = new byte[frameSize];
        int ySize = cx * cy;
        byte[] uv = new byte[cx * cy / 2];
        uint inc = 0;
        int frameIntervalMs = Math.Max(1, 1000 / fps);
        long start = DateTime.UtcNow.Ticks;

        while (true)
        {
            double t = (DateTime.UtcNow.Ticks - start) / 10000000.0;
            if (t > 60) break;

            int bar = (int)(t * 100) % cx;
            for (int y = 0; y < cy; y++)
            {
                int row = y * cx;
                for (int x = 0; x < cx; x++)
                {
                    int v;
                    if (Math.Abs(x - bar) < 8) v = 235;
                    else if (x < cx / 3) v = 80;
                    else if (x < 2 * cx / 3) v = 145;
                    else v = 200;
                    nv[row + x] = (byte)(v + (y % 32) / 8);
                }
            }
            for (int i = 0; i < uv.Length; i++) uv[i] = 128;
            Buffer.BlockCopy(uv, 0, nv, ySize, uv.Length);

            inc++;
            WriteFrame(nv, inc);
            System.Threading.Thread.Sleep(frameIntervalMs);
        }
    }

    static int Main(string[] args)
    {
        cx = 1280; cy = 720; int fps = 30; bool test = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--w" && i + 1 < args.Length) cx = int.Parse(args[++i]);
            else if (args[i] == "--h" && i + 1 < args.Length) cy = int.Parse(args[++i]);
            else if (args[i] == "--fps" && i + 1 < args.Length) fps = int.Parse(args[++i]);
            else if (args[i] == "--test") test = true;
        }
        if (cx <= 0 || cy <= 0 || fps <= 0 || cx % 2 != 0 || cy % 2 != 0)
        {
            Console.Error.WriteLine("uso: vcam-feed --w 1280 --h 720 --fps 30 [--test]");
            return 1;
        }

        QueryPerformanceFrequency(out freq);
        QueryPerformanceCounter(out startTicks);

        IntPtr existing = OpenFileMappingW(FILE_MAP_READ, false, "OBSVirtualCamVideo");
        if (existing != IntPtr.Zero)
        {
            CloseHandle(existing);
            Console.Error.WriteLine("ERROR: OBSVirtualCamVideo ya está en uso (¿OBS u otra app la tiene abierta?)");
            return 2;
        }

        frameSize = cx * cy * 3 / 2;
        ulong interval = (ulong)(10000000.0 / fps);

        int size = 80;
        size = (size + 31) & ~31;
        off0 = size;
        size += frameSize + FRAME_HEADER_SIZE;
        size = (size + 31) & ~31;
        off1 = size;
        size += frameSize + FRAME_HEADER_SIZE;
        size = (size + 31) & ~31;
        off2 = size;
        size += frameSize + FRAME_HEADER_SIZE;
        size = (size + 31) & ~31;

        mapping = CreateFileMappingW(new IntPtr(-1), IntPtr.Zero, PAGE_READWRITE, 0, (uint)size, "OBSVirtualCamVideo");
        if (mapping == IntPtr.Zero)
        {
            Console.Error.WriteLine("ERROR: CreateFileMappingW falló: " + Marshal.GetLastWin32Error());
            return 2;
        }
        view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, UIntPtr.Zero);
        if (view == IntPtr.Zero)
        {
            Console.Error.WriteLine("ERROR: MapViewOfFile falló: " + Marshal.GetLastWin32Error());
            return 2;
        }

        QueueHeader h = new QueueHeader();
        h.state = STATE_STARTING;
        h.cx = (uint)cx;
        h.cy = (uint)cy;
        h.interval = interval;
        h.type = 0;
        h.offsets0 = (uint)off0;
        h.offsets1 = (uint)off1;
        h.offsets2 = (uint)off2;
        Marshal.StructureToPtr(h, view, false);

        Console.Error.WriteLine("VCAM OK " + cx + "x" + cy + "@" + fps);

        if (test)
        {
            RunTestPattern(fps);
            Cleanup();
            return 0;
        }

        using (Stream stdin = Console.OpenStandardInput())
        {
            byte[] frame = new byte[frameSize];
            uint inc = 0;
            while (true)
            {
                int read = 0;
                while (read < frameSize)
                {
                    int n = stdin.Read(frame, read, frameSize - read);
                    if (n <= 0) { Cleanup(); return 0; }
                    read += n;
                }
                inc++;
                WriteFrame(frame, inc);
            }
        }
    }
}