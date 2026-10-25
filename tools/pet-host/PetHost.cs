// PetHost.cs —— 桌宠宿主 v8（WebView2CompositionControl 真透明 + 原生拖动/原生菜单）
// ============================================================================
// 主人 2026-10-24 要求「背景为什么不是透明的」。查证过程与结论：
//
// 【为什么之前不透明】
//   v6 用普通 WebView2 控件 + 事后 WS_EX_LAYERED 色键：
//     · WPF 在 Show 之后会把 EX 样式刷回去 ⇒ SetLayeredWindowAttributes 恒返回 False
//     · 改 WinForms + TransparencyKey ⇒ EnsureCoreWebView2Async 抛 0x8007139F
//     · WPF AllowsTransparency=true 配普通 WebView2 ⇒ 鼠标进不了页面
//   官方唯一支持**逐像素透明**的 WPF 控件是 WebView2CompositionControl（DirectComposition，
//   windowless），旧包 1.0.2903.40 里没有这个类型，1.0.3351.48 的 lib/net462 里才有。
//
// 【实测矩阵】tools/pet-host/comp-probe/comp-probe2.log
//   normal  普通窗 + 洋红页  → 中心 #00FF00 / 四角 #FF00FF  控件渲染正常
//   layered 分层窗 + 洋红页  → 中心 #00FF00 / 四角 #FF00FF  分层窗下也渲染
//   layeredt 分层窗 + 透明页 → 中心 #00FF00 / 四角=桌面       **真透明成立**
//   且分层窗下 mousedown/mouseup/click 全部进页面（v6 那个黑洞消失）
//
// 【业界验证】同类生产实现（TokenTracker 的 PetWindow.cs，同为 WPF+CompositionControl
//   的 Windows 桌宠）用的就是这套，并补了 6 条我们没踩到的坑，v8 全部照做：
//   ① AllowExternalDrop=false —— windowless 托管下不改这个，初始化直接抛
//   ② 设 WEBVIEW2_DEFAULT_BACKGROUND_COLOR=0 + 初始化后再设 DefaultBackgroundColor=全透明
//      ——否则页面 CSS 落地前会闪一块底色
//   ③ AddScriptToExecuteOnDocumentCreatedAsync 先注入 background:transparent!important
//   ④ WS_EX_TRANSPARENT 轮询：指针在透明留白上时让点击穿到桌面（否则整个方框吃掉桌面点击）
//   ⑤ 拖动交给系统：ReleaseCapture + WM_NCLBUTTONDOWN/HTCAPTION（比手算 dx dy 稳）
//   ⑥ 右键用**原生 WPF ContextMenu**（页面内菜单会被窗口边界裁掉）
//   另外它还说明：这个透明置顶窗收不到可靠的 mouseleave ⇒ 悬停靠轮询；WS_EX_TOOLWINDOW
//   才能不进 Alt+Tab。
//
// 结构：无边框分层窗（全透明底）→ WebView2CompositionControl → tools/pet-page/index.html
// 交互：页面 postMessage('pet:drag') → 宿主原生拖动
//       页面 postMessage('menu') → 宿主弹原生右键菜单 → 点完把 act 回灌给页面执行
//       页面 postMessage('cmd:<json>') → 写 pet-cmd.json（keeper ≤10 秒应用）
//       宿主每 2 秒把 pet-window-state.json 推给页面
// ============================================================================
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

public class PetHostApp
{
    // ── P/Invoke ──
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr wp, IntPtr lp);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    const int GWL_EXSTYLE = -20;
    const long WS_EX_TRANSPARENT = 0x00000020L;
    const long WS_EX_TOOLWINDOW = 0x00000080L;
    /// <summary>永不激活：全屏弹幕层用，保证它绝不抢任何应用的键盘焦点。</summary>
    const long WS_EX_NOACTIVATE = 0x08000000L;
    const int WM_NCLBUTTONDOWN = 0xA1;
    const int HTCAPTION = 2;
    const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020;

    public static bool HasOtherWindow(uint myPid)
    {
        bool found = false;
        EnumWindows((h, l) =>
        {
            StringBuilder sb = new StringBuilder(64);
            GetWindowText(h, sb, 64);
            string t = sb.ToString();
            if (t == "deskpet" || t == "deskpet-webview")
            {
                uint p; GetWindowThreadProcessId(h, out p);
                if (p != myPid) { found = true; return false; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string Home;
    public static Window Win;
    public static WebView2CompositionControl Wv;
    public static string LogFile, BootLog, StateFile, CmdFile;
    static IntPtr Hwnd = IntPtr.Zero;

    public static void Log(string msg)
    {
        // host.log 写入在这台机器上静默失败（权限/FileInfo），统一写 exe 同目录 trace.txt
        try
        {
            string line = "[" + DateTime.Now.ToString("HH:mm:ss.fff") + "] " + msg + "\n";
            string exeDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            File.AppendAllText(Path.Combine(exeDir, "trace.txt"), line, Encoding.UTF8);
            if (LogFile != null) { try { File.AppendAllText(LogFile, line, Encoding.UTF8); } catch { } }
        }
        catch { }
    }

    [STAThread]
    public static void Main(string[] args)
    {
        string bootLog = Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location), "pet-host-boot.log");
        BootLog = bootLog;
        Action<string> boot = (m) => { try { File.AppendAllText(bootLog, "[" + DateTime.Now.ToString("HH:mm:ss.fff") + "] " + m + "\n", Encoding.UTF8); } catch { } };
        try
        {
            // 必须声明 DPI 感知：否则 WPF 用 DIP、GetCursorPos/GetWindowRect 用物理像素，
            // 点击穿透判定和诊断会整体错位（v6 查透明时就被这个坑误判过一次）。
            try { SetProcessDPIAware(); } catch { }
            // ② WebView2 浏览器进程启动前就指定默认背景为透明（0 = 全透明 ARGB）
            try { Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0"); } catch { }

            boot("start args=" + string.Join(" ", args) + " v8-composition");
            Home = Environment.GetEnvironmentVariable("DOUYIN_HOME");
            boot("DOUYIN_HOME=" + (Home ?? "(null)"));
            if (string.IsNullOrEmpty(Home)) Home = Environment.GetEnvironmentVariable("DESKPET_HOME");
            if (string.IsNullOrEmpty(Home))
            {
                string guess = @"D:\DeepSeek\dsh-data\douyin-duty";
                if (Directory.Exists(guess)) Home = guess;
                boot("guess home=" + (Home ?? "(null)"));
            }
            if (string.IsNullOrEmpty(Home)) { boot("no home -> exit"); return; }

            LogFile = Path.Combine(Home, "pet-host.log");
            StateFile = Path.Combine(Home, "pet-window-state.json");
            CmdFile = Path.Combine(Home, "pet-cmd.json");
            Log("=== PetHost v8 start pid=" + Process.GetCurrentProcess().Id + " home=" + Home);
            boot("logging to " + LogFile);

            if (HasOtherWindow((uint)Process.GetCurrentProcess().Id))
            {
                Log("singleton: another pet window exists -> exit");
                boot("singleton exit");
                return;
            }
            boot("singleton ok");

            // 🔴🔴 2026-10-25 主人：「关闭 DSH 没有关闭宠物面板」。
            //    根因：宿主（DSH）是用 spawn 起 PetHost.exe 的，但进程**不共享生命周期** ——
            //      · keeper 只在 cfg.petOn 变 false / 插件卸载时才 kill 子女进程；
            //      · DSH 整个退出时插件代码根本没机会跑收尾（进程直接没了），
            //        PetHost 变成孤儿继续待在最上层。
            //      · 而且状态文件里 on 还是 true、10 分钟内不算 stale ⇒ 它也不自杀。
            //    正解：让 PetHost **自己盯父进程**。父进程没了，我立刻收摊。
            //    用 PollParent() 轮询（比 Job Object 简单可靠，不依赖句柄继承细节）。
            StartParentWatch();
            boot("parent watch started");

            var app = new Application();
            app.DispatcherUnhandledException += (s, e) =>
            {
                Log("DISPATCHER EXC: " + e.Exception.GetType().Name + ": " + e.Exception.Message);
                e.Handled = true;
            };
            app.Startup += (s, e) =>
            {
                boot("startup handler enter");
                try { BuildWindow(); boot("BuildWindow returned"); }
                catch (Exception ex) { boot("BuildWindow EXC: " + ex.GetType().Name + ": " + ex.Message + "\n" + ex.StackTrace); }
            };
            boot("app.Run");
            app.Run();
            Log("=== PetHost exit");
            boot("app.Run returned");
        }
        catch (Exception ex)
        {
            Log("FATAL: " + ex.GetType().Name + ": " + ex.Message + "\n" + ex.StackTrace);
            boot("FATAL: " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    static string SpriteDir = null;
    static bool StaleLogged = false;
    static int DiagN = 0;
    static DispatcherTimer Poll, ClickThroughTimer;
    static bool ClickThrough = false;
    static bool Dragging = false;
    static bool CoreReady = false;

    // 窗口尺寸（DIP）。引擎页是 1024×1024 正方形画布 ⇒ 画布区给正方形，人物不变形。
    // 🔴 2026-10-24 主人「人物比例还有点大」：原来 320 DIP，在 180% 缩放屏上 = 576 物理像素，
    //    占了 1325 宽屏幕的 43%，确实太大。改成 **240 DIP（=432 物理，占 33%）**。
    //    ⚠️ 这不是"缩放人物"—— canvas 始终 1:1，改的是窗口，人物跟着等比缩，不变形。
    //
    // 🔴 2026-10-25 主人「你的文本框好像显示不完全」——两次修正：
    //    ① 根因：气泡向上生长，而窗口只有画布那么大（气泡底边在 #pet 高 18% 处，
    //       240×0.18≈43px）⇒ 两行以上就被窗口顶边裁掉。
    //    ② 第一次只加高气泡带（132）不够：66 字长句仍 clipped=True（气泡高 209px）。
    //       真正的问题是**气泡太窄**（只有 121px），中文只能竖着长。
    //    所以现在三个数分开：
    //       CanvasW = 画布（人物）的边长 —— 决定她多大
    //       BubbleBand = 顶部留多高 —— 决定气泡能长几行
    //       BubbleWiden = 左右各加宽多少 —— 决定气泡铺多宽（横向铺开，行数就少）
    //    窗口 = (CanvasW + BubbleWiden*2) × (CanvasW + BubbleBand + FootGap)
    //
    // 🔴🔴🔴 2026-10-25 晚 主人 7 条反馈里的 1/2/3 —— 布局整体重做：
    //    「宠物下面的对话框要固定位置不要因为点击对话框就自动弹上去了，
    //      该变的是文本输出框，应该弹在下面」
    //    「文本输入框太丑了」「文本框只能输入三行就不变化了」
    //
    //    病根（三个叠在一起）：
    //      ① FootGap 只有 34 DIP，而输入框要 26~60 的高度 ⇒ 它必然**顶出脚位**、
    //         盖到她身上；`body.talking #toolbar{bottom: foot-gap + 2}` 又把按钮条
    //         往上推，视觉上就是"一聚焦整块往上跳"。
    //      ② 输入框高度靠 autoGrow() 改 style.height，而 #talkbar 是 flex 里
    //         对齐 flex-end 的绝对定位块 ⇒ 长高时**从底边往上长**，
    //         于是"点一下、框就往上弹"。
    //      ③ 26→60px 的 max-height 只够 3 行（11.5px 字号 + 15px 行高），
    //         第 4 行开始内部滚动 —— 主人说的"只能输入三行就变化了"。
    //
    //    解法（本文件 + pet.css 一起）：
    //      · **固定一条输入区**（FootGap 从 34 提到 74 DIP），输入框永远贴在这条缝里，
    //        高度由 CSS 定（min 34 / max 96 = 6 行），**长高时往下长、不动底边也不动顶边**；
    //      · 输入框一旦"长高"只在自己那条缝里长，绝不推动她、绝不推动按钮条；
    //      · 气泡（文本输出）仍在画布上方 —— 主人说的"该变的是文本输出框"。
    //    按钮条和输入框**共用**这条缝：按钮条贴缝底、输入框贴缝顶，互不挤。
    static int CanvasW = 240;
    static int BubbleBand = 170;
    static int BubbleWiden = 100;
    /// <summary>画布下面的「输入区」高度（DIP）。
    /// 2026-10-25：34 → 74 → **152**。这个值一路涨是因为它就是那条缝的**高度预算**，
    /// 而弹幕/按钮条/输入框全住在这条缝里，少一像素就会被窗口底边裁掉：
    ///   74 = 只够「按钮条 + 一行输入框」，输入框长到第 3 行就开始被裁；
    ///   152 = 按钮条 27 + 间距 4 + 输入框外壳 14 + 输入框最多 100 + 底留白 6 + 余量 1
    ///         （实测各块高度见 pet.css 的注释），5 行全展开也一行不裁。
    /// ⚠️ 这个值会作为 --foot-gap 注入页面，#dock 的 top 直接拿它算锚点 ——
    ///    改这里不用改 CSS，两边自动跟着走。
    /// ⚠️ 但它同时决定窗口总高（WH = 画布 + 气泡带 + FootGap）：
    ///    240 + 170 + 152 = 562 DIP。屏幕 1583 可用高，完全放得下。</summary>
    static int FootGap = 152;
    static int WW = 240 + 200;   // 窗口宽（DIP）—— 下面 RecomputeWin() 算
    static int WH = 240 + 170;   // 窗口高（DIP）

    const int WW_MIN = 160, WW_MAX = 520;

    static void RecomputeWin()
    {
        WW = CanvasW + BubbleWiden * 2;
        WH = CanvasW + BubbleBand + FootGap;   // 画布 + 气泡带 + 输入区
        Log("window = " + WW + "x" + WH + " (画布 " + CanvasW + " / 气泡带 " + BubbleBand
            + " / 输入区 " + FootGap + " / 左右各 " + BubbleWiden + ")");
    }

    /// <summary>主人可以在 pet-window-pos.json 里写 Size / BubbleBand / BubbleWiden 调她：
    ///   Size        = 人物画布边长（160–520，默认 240）
    ///   BubbleBand  = 顶部气泡空间（100–320，默认 170）
    ///   BubbleWiden = 气泡左右多宽（0–220，默认 100）
    /// 没写就用默认；非法值一律忽略，不因为一个坏数字让她消失。</summary>
    static void ReadSizeFromCfg(Dictionary<string, object> j)
    {
        try
        {
            if (j != null && j.ContainsKey("Size"))
            {
                int s = Convert.ToInt32(j["Size"]);
                if (s < WW_MIN || s > WW_MAX) { Log("Size 超范围(" + s + ") -> 忽略"); }
                else { CanvasW = s; Log("size from cfg = " + s); }
            }
            if (j != null && j.ContainsKey("BubbleBand"))
            {
                try
                {
                    int b = Convert.ToInt32(j["BubbleBand"]);
                    if (b >= 100 && b <= 320) { BubbleBand = b; Log("BubbleBand from cfg = " + b); }
                }
                catch { /* 坏值用默认 */ }
            }
            if (j != null && j.ContainsKey("BubbleWiden"))
            {
                try
                {
                    int w2 = Convert.ToInt32(j["BubbleWiden"]);
                    if (w2 >= 0 && w2 <= 220) { BubbleWiden = w2; Log("BubbleWiden from cfg = " + w2); }
                }
                catch { /* 坏值用默认 */ }
            }
        }
        catch { /* 全用默认 */ }
        RecomputeWin();
    }

    static void BuildWindow()
    {
        Log("BW1 enter (v9)");
        Win = new Window();
        Win.WindowStyle = WindowStyle.None;
        Win.ResizeMode = ResizeMode.NoResize;
        // ★ 核心：分层窗 + 全透明底，alpha 由 WebView2 合成表面提供（逐像素透明）
        Win.AllowsTransparency = true;
        Win.Background = Brushes.Transparent;
        Win.Topmost = true;
        Win.ShowInTaskbar = false;
        // 🔴 2026-10-25 主人「文本输入框点击之后依旧没跟你对话」的真因：
        //    ShowActivated=false 让窗口**永远拿不到键盘焦点**，点进 input 框虽然光标在闪，
        //    但敲的字进不去（键盘事件发不到这个窗）。分层透明窗还带着 WS_EX_NOACTIVATE。
        //    所以：允许激活（ShowActivated=true），但**显示时用 ShowActivated 之外的时机**
        //    —— Show() 那一刻不抢焦点，等主人真的点输入框时页面发 pet:focus 再主动 Activate()。
        Win.ShowActivated = true;
        // 🔴 2026-10-25 顺序 bug：原来这里直接 Win.Width=WW 用的是**静态默认值**，
        //    而真正算尺寸的 RecomputeWin() 在下面 RestorePlacement() 里才跑 ⇒
        //    窗口高度少了 FootGap（实测 440x410 而不是 440x444），脚位整块不存在，
        //    按钮条又压回脚上了。现在：**先把配置读进来算完，再赋尺寸**。
        RestorePlacement();          // 里面会 ReadSizeFromCfg + RecomputeWin
        Win.Width = WW;
        Win.Height = WH;
        Win.Title = "deskpet-webview";
        Log("BW2 props ok allowsTransparency=" + Win.AllowsTransparency + " size=" + WW + "x" + WH);

        Log("BW3 create composition control");
        // ① AllowExternalDrop 必须关：windowless（DirectComposition）托管下开着会抛
        Wv = new WebView2CompositionControl();
        Wv.AllowExternalDrop = false;
        Log("BW4 control created " + Wv.GetType().Name);
        Win.Content = Wv;

        Win.SourceInitialized += (s, e) => OnSourceInitialized();
        Win.Closed += (s, e) =>
        {
            try { Poll.Stop(); } catch { }
            try { ClickThroughTimer.Stop(); } catch { }
            SavePos();
            Log("window closed");
        };

        Win.Show();
        Log("BW5 shown " + Win.Width + "x" + Win.Height);
        DiagWindow();

        Poll = new DispatcherTimer();
        Poll.Interval = TimeSpan.FromSeconds(2);
        Poll.Tick += (s, e) => { try { PollOnce(); } catch (Exception ex) { Log("poll EXC: " + ex.Message); } };
        Poll.Start();
        PollOnce();

        // 她的"所思所想"单独一条快通道（500ms）：主轮询 2 秒对"她在干嘛"太慢，
        // 主人盯着看的时候会觉得她卡住了。
        var actTimer = new DispatcherTimer();
        actTimer.Interval = TimeSpan.FromMilliseconds(500);
        actTimer.Tick += (s, e) => { try { PushActivity(); } catch { } };
        actTimer.Start();

        // ④ 点击穿透：轮询指针，落在透明留白上就把窗口设成 WS_EX_TRANSPARENT
        ClickThroughTimer = new DispatcherTimer();
        ClickThroughTimer.Interval = TimeSpan.FromMilliseconds(60);
        ClickThroughTimer.Tick += (s, e) => { try { ClickThroughTick(); } catch { } };
        ClickThroughTimer.Start();

        var initTimer = new DispatcherTimer();
        initTimer.Interval = TimeSpan.FromMilliseconds(600);
        initTimer.Tick += (s, e) =>
        {
            initTimer.Stop();
            Log("initTimer fired -> InitWebViewAsync");
            try { InitWebViewAsync(); } catch (Exception ex) { Log("InitWebViewAsync EXC: " + ex.Message); }
        };
        initTimer.Start();
    }

    static void OnSourceInitialized()
    {
        Hwnd = new WindowInteropHelper(Win).Handle;
        // WS_EX_TOOLWINDOW：不进 Alt+Tab / Win+Tab（ShowInTaskbar=false 只管任务栏按钮）
        long ex = GetWindowLongPtr(Hwnd, GWL_EXSTYLE).ToInt64();
        SetWindowLongPtr(Hwnd, GWL_EXSTYLE, new IntPtr(ex | WS_EX_TOOLWINDOW));
        Log("OnSourceInitialized ex=0x" + GetWindowLongPtr(Hwnd, GWL_EXSTYLE).ToInt64().ToString("X8"));
    }

    static void DiagWindow()
    {
        try
        {
            if (Hwnd == IntPtr.Zero) Hwnd = new WindowInteropHelper(Win).Handle;
            RECT wr; GetWindowRect(Hwnd, out wr);
            long ex = GetWindowLongPtr(Hwnd, GWL_EXSTYLE).ToInt64();
            Log("BW8 hwnd=" + Hwnd + " rect=" + wr.L + "," + wr.T + "," + wr.R + "," + wr.B
                + " size=" + (wr.R - wr.L) + "x" + (wr.B - wr.T)
                + " ex=0x" + ex.ToString("X8") + " (LAYERED=" + ((ex & 0x80000) != 0) + " TOOLWIN=" + ((ex & WS_EX_TOOLWINDOW) != 0) + ")");
        }
        catch (Exception ex) { Log("BW8 EXC: " + ex.Message); }
    }

    // ── 位置：必须夹在工作区内 ──
    // 🔴 主人这边屏幕物理 1325×926 @180%（= DIP 736×514）。旧 pos 文件里存的是
    //    上一次（非 DPI 感知时代）的坐标 890,224，直接拿来用就跑到屏幕外面——
    //    窗口 320 DIP=576 物理，顶部 405 物理 ⇒ 底部 981 > 926，底部按钮条整块看不见。
    //    所以读盘之后一律夹回工作区。
    static void RestorePlacement()
    {
        var wa = SystemParameters.WorkArea;
        // 先读尺寸（可以在同一个文件里写 Size 调她多大），再算位置
        try
        {
            string posFile0 = Path.Combine(Home, "pet-window-pos.json");
            if (File.Exists(posFile0))
            {
                var ser0 = new JavaScriptSerializer();
                ReadSizeFromCfg(ser0.Deserialize<Dictionary<string, object>>(File.ReadAllText(posFile0, Encoding.UTF8).TrimStart('\uFEFF')));
            }
        }
        catch { }
        // 默认位置：右下角（人物贴右下）
        double left = wa.Right - WW + BubbleWiden;      // 让**人物**贴右边
        double top = wa.Bottom - WH + BubbleBand;       // 让**人物**贴底
        try
        {
            string posFile = Path.Combine(Home, "pet-window-pos.json");
            if (File.Exists(posFile))
            {
                var ser = new JavaScriptSerializer();
                var j = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(posFile, Encoding.UTF8).TrimStart('\uFEFF'));
                if (j.ContainsKey("X") && j.ContainsKey("Y"))
                {
                    double x = Convert.ToDouble(j["X"]); double y = Convert.ToDouble(j["Y"]);
                    if (!double.IsNaN(x) && !double.IsNaN(y)) { left = x; top = y; }
                    Log("pos from file: " + x + "," + y);
                }
            }
        }
        catch (Exception ex) { Log("pos read EXC: " + ex.Message); }
        // 🔴 这里也要按「人物矩形」夹取（同 ClampIntoWorkArea），否则读回一个旧的
        //    按整窗夹取时代存下的 X/Y 会把她重新困在离边缘 100px 的地方。
        Win.Left = left;
        Win.Top = top;
        ClampIntoWorkArea();
        Log("placement: win=" + (int)Win.Left + "," + (int)Win.Top
            + " pet=" + (int)(Win.Left + BubbleWiden) + "," + (int)(Win.Top + BubbleBand)
            + " (workarea " + wa.Left + "," + wa.Top + "," + wa.Right + "," + wa.Bottom + ")");
    }

    /// <summary>把她夹回工作区。
    /// 🔴🔴 2026-10-25 主人：「现在移动这个宠物移动不出屏幕外，甚至人物都不能靠边」
    ///    真因：窗口比人物大（左右各留 BubbleWiden 给气泡、上面留 BubbleBand），
    ///    而夹取是按**整个窗口**做的 ⇒ 人物离屏幕边缘永远差 [BubbleWiden] 那么远，靠不到边。
    ///    修法：按**人物（画布）矩形**夹取，窗口允许伸出屏幕（气泡/余量在屏幕外没关系，
    ///    它们本来就是透明的）。这样人物能真的贴着屏幕边缘。
    ///    ⚠️ 只要求人物**至少有 40% 在屏内**，允许露出一点（业界桌宠都允许半只露在外，
    ///    但整只跑没就找不回来了）。</summary>
    static void ClampIntoWorkArea()
    {
        try
        {
            var wa = SystemParameters.WorkArea;
            double x = Win.Left, y = Win.Top;
            if (double.IsNaN(x) || double.IsNaN(y)) return;
            // 人物（画布）在窗口内的偏移：左右各 BubbleWiden，顶部 BubbleBand
            double petL = BubbleWiden, petT = BubbleBand;
            double petW = CanvasW, petH = CanvasW;
            // 允许露出屏幕的比例（0.4 = 至少 40% 在屏内）
            const double keep = 0.4;
            // 人物矩形的合法范围：左边最多让 petW*(1-keep) 露出去，右边同理
            double minX = wa.Left - petL - petW * (1 - keep);
            double maxX = wa.Right + petL - petW * keep;
            double minY = wa.Top - petT - petH * (1 - keep);
            double maxY = wa.Bottom + petT - petH * keep;
            double cl = Math.Max(minX, Math.Min(x, Math.Max(minX, maxX)));
            double ct = Math.Max(minY, Math.Min(y, Math.Max(minY, maxY)));
            if (Math.Abs(cl - Win.Left) > 1 || Math.Abs(ct - Win.Top) > 1)
            {
                Log("clamp: " + (int)Win.Left + "," + (int)Win.Top + " -> " + (int)cl + "," + (int)ct
                    + " (人物矩形 " + (int)(cl + petL) + "," + (int)(ct + petT) + " " + CanvasW + "x" + CanvasW + ")");
                Win.Left = cl;
                Win.Top = ct;
            }
        }
        catch { }
    }

    static void SavePos()
    {
        try
        {
            var ser = new JavaScriptSerializer();
            var d = new Dictionary<string, object>();
            // 🔴 2026-10-25 修「窗口跳到屏幕外」：SavePos 之前会把奇奇怪怪的值写盘，
            //    下次启动读回来就跑到屏幕外（实测存成过 2148,934，而屏幕只有 1325×926）。
            //    现在**写盘前先夹回工作区**，坏值根本进不了文件。
            var wa = SystemParameters.WorkArea;
            double x = Win.Left, y = Win.Top;
            if (double.IsNaN(x) || double.IsNaN(y)) { Log("SavePos: NaN -> skip"); return; }
            // 🔴 写盘前按**人物矩形**夹取（同 ClampIntoWorkArea），不是按整窗：
            //    按整窗夹会把她靠边时的位置改成离边 100px，下次启动就"靠不了边"了。
            const double keep = 0.4;
            double minX = wa.Left - BubbleWiden - CanvasW * (1 - keep);
            double maxX = wa.Right + BubbleWiden - CanvasW * keep;
            double minY = wa.Top - BubbleBand - CanvasW * (1 - keep);
            double maxY = wa.Bottom + BubbleBand - CanvasW * keep;
            x = Math.Max(minX, Math.Min(x, Math.Max(minX, maxX)));
            y = Math.Max(minY, Math.Min(y, Math.Max(minY, maxY)));
            d["X"] = x; d["Y"] = y;
            d["Size"] = CanvasW;         // 人物大小
            d["BubbleBand"] = BubbleBand; // 气泡带高度
            d["BubbleWiden"] = BubbleWiden; // 气泡左右宽度
            File.WriteAllText(Path.Combine(Home, "pet-window-pos.json"), ser.Serialize(d), new UTF8Encoding(false));
        }
        catch { }
    }

    // ── ④ 点击穿透判定 ──
    // 她只在"人物轮廓"里占像素；四周是透明留白。指针在留白上时把窗口设成
    // WS_EX_TRANSPARENT，点击就穿到桌面/下层窗口。拖动时不做（会抖）。
    //
    // 🔴 2026-10-24 修过一次严重 bug：一开始用 Win.PointFromScreen() 算窗口局部坐标，
    //    在 180% 缩放下它返回的坐标跑到判定框外面 ⇒ **她的整个窗口都被当成留白**，
    //    全程 WS_EX_TRANSPARENT ⇒ 点她、右键全部穿到桌面，"点不了"重现。
    //    现在全部用**物理像素**算：GetCursorPos vs GetWindowRect，不经 WPF 变换。
    //    命中区 = 页面报来的**人物 alpha 包围盒** ∪ 按钮条 / 台词条 / 泡泡（页面报矩形）。
    //    页面还没报之前（启动那一刻）⇒ 整个窗口都算"她"，宁可吃掉点击也不能点不到。
    static RECT LastWinRect;
    static int HitLogN = 0;

    // 页面报来的命中矩形（窗口局部 CSS px；CSS px 在 composition 控件里 1:1 对应 DIP）
    static double BoxX = 0, BoxY = 0, BoxW = 0, BoxH = 0;   // 人物包围盒
    static bool BoxValid = false;
    static double TbY = -1, TbX = 0, TbW = 0, TbH = 0;      // 按钮条
    static bool TbValid = false;
    static double TlY = -1, TlX = 0, TlW = 0, TlH = 0;      // 台词条
    static bool TlValid = false;
    static double BbY = -1, BbX = 0, BbW = 0, BbH = 0;      // 泡泡
    static bool BbValid = false;
    // ⭐ 2026-10-25 深夜：#dock（按钮条 + 输入框那个竖排容器）的并集。
    //   为什么必须单独报：按钮条能藏起来，藏起来之后输入框顶上那一段在宿主眼里
    //   就是"透明留白" ⇒ 点它会穿到桌面，输入框再也点不开。见 IsPointOnPet。
    static double DkY = -1, DkX = 0, DkW = 0, DkH = 0;
    static bool DkValid = false;

    static void ClickThroughTick()
    {
        if (Hwnd == IntPtr.Zero || !Win.IsVisible || Dragging) return;
        POINT p;
        if (!GetCursorPos(out p)) return;
        RECT wr; GetWindowRect(Hwnd, out wr);
        LastWinRect = wr;
        bool onPet = IsPointOnPet(p, wr);
        SetClickThrough(!onPet);
        // 每 ~2 秒记一次判定证据（光标/窗口矩形/命中框），排查"点不了"时全靠它
        if (++HitLogN % 33 == 0)
            Log("hit: cur=" + p.X + "," + p.Y + " win=" + wr.L + "," + wr.T + "," + (wr.R - wr.L) + "x" + (wr.B - wr.T)
                + " onPet=" + onPet + " box=" + (BoxValid ? (BoxX + "," + BoxY + "," + BoxW + "x" + BoxH) : "(none)")
                + " tb=" + (TbValid ? (TbX + "," + TbY + "," + TbW + "x" + TbH) : "-")
                + " dk=" + (DkValid ? (DkX + "," + DkY + "," + DkW + "x" + DkH) : "-")
                + " clickthrough=" + ClickThrough);
    }

    /// <summary>光标（物理像素）是否落在"她"身上。窗口矩形也是物理像素。</summary>
    static bool IsPointOnPet(POINT screenPt, RECT wr)
    {
        int ww = wr.R - wr.L, wh = wr.B - wr.T;
        if (ww <= 0 || wh <= 0) return true;
        int cx = screenPt.X - wr.L, cy = screenPt.Y - wr.T;   // → 窗口内物理像素
        if (cx < 0 || cy < 0 || cx >= ww || cy >= wh) return false;

        // 页面还没报包围盒 ⇒ 整个窗口都算她（点得到优先）
        if (!BoxValid) return true;

        // CSS px → 物理像素（按窗口宽度等比缩放；composition 控件是 1:1 DIP）
        double scale = (double)ww / Math.Max(1.0, WW);
        Func<double, double> S = (v) => v * scale;

        if (InsideBox(cx, cy, S(BoxX), S(BoxY), S(BoxW), S(BoxH))) return true;
        if (TbValid && InsideBox(cx, cy, S(TbX), S(TbY), S(TbW), S(TbH))) return true;
        if (TlValid && InsideBox(cx, cy, S(TlX), S(TlY), S(TlW), S(TlH))) return true;
        if (BbValid && InsideBox(cx, cy, S(BbX), S(BbY), S(BbW), S(BbH))) return true;
        // ⭐ 2026-10-25 深夜：#dock（按钮条 + 输入框那个竖排容器）
        //   页面把它报上来了就必须认，否则"按钮条藏起来、输入框在它原来的位置"
        //   这一段在宿主眼里是留白 ⇒ 点输入框会穿到桌面，输入框再也点不开。
        if (DkValid && InsideBox(cx, cy, S(DkX), S(DkY), S(DkW), S(DkH))) return true;
        return false;
    }

    static bool InsideBox(double cx, double cy, double x, double y, double w, double h)
    {
        // 留 2px 容差，边缘毛刺不至于让点击漏出去
        return cx >= x - 2 && cy >= y - 2 && cx <= x + w + 2 && cy <= y + h + 2;
    }

    /// <summary>页面报命中矩形：'pet:box:' 人物包围盒 / 'pet:ui:' 按钮条·台词条·泡泡。</summary>
    static void OnHitRects(string msg)
    {
        try
        {
            var ser = new JavaScriptSerializer();
            string json = msg.Substring(msg.IndexOf(':') + 1);   // 去掉 "pet:"
            json = json.Substring(json.IndexOf(':') + 1);        // 去掉 "box:"/"ui:"
            var j = ser.Deserialize<Dictionary<string, object>>(json);
            bool isBox = msg.StartsWith("pet:box:");
            Func<string, double> D = (k) => j.ContainsKey(k) ? Convert.ToDouble(j[k]) : 0;
            double x = D("x"), y = D("y"), w = D("w"), h = D("h");
            if (isBox)
            {
                BoxX = x; BoxY = y; BoxW = w; BoxH = h; BoxValid = (w > 4 && h > 4);
            }
            else
            {
                // ui 消息带 tb/tl/bb 三组，缺省 = 不可见
                BoxRectA(ref TbX, ref TbY, ref TbW, ref TbH, ref TbValid, j, "tb");
                BoxRectA(ref TlX, ref TlY, ref TlW, ref TlH, ref TlValid, j, "tl");
                BoxRectA(ref BbX, ref BbY, ref BbW, ref BbH, ref BbValid, j, "bb");
                BoxRectA(ref DkX, ref DkY, ref DkW, ref DkH, ref DkValid, j, "dk");
            }
        }
        catch (Exception ex) { Log("OnHitRects EXC: " + ex.Message); }
    }

    static void BoxRectA(ref double bx, ref double by, ref double bw, ref double bh, ref bool valid,
        Dictionary<string, object> j, string key)
    {
        if (!j.ContainsKey(key) || j[key] == null) { valid = false; return; }
        var d = j[key] as Dictionary<string, object>;
        if (d == null) { valid = false; return; }
        bx = Convert.ToDouble(d["x"]); by = Convert.ToDouble(d["y"]);
        bw = Convert.ToDouble(d["w"]); bh = Convert.ToDouble(d["h"]);
        valid = (bw > 2 && bh > 2);
    }

    static long GetEx() { return Hwnd == IntPtr.Zero ? 0 : GetWindowLongPtr(Hwnd, GWL_EXSTYLE).ToInt64(); }

    static void SetClickThrough(bool enabled)
    {
        if (Hwnd == IntPtr.Zero || enabled == ClickThrough) return;
        long ex = GetEx();
        long upd = enabled ? (ex | WS_EX_TRANSPARENT) : (ex & ~WS_EX_TRANSPARENT);
        SetWindowLongPtr(Hwnd, GWL_EXSTYLE, new IntPtr(upd));
        long applied = GetEx();
        if (((applied & WS_EX_TRANSPARENT) != 0) != enabled) return;
        ClickThrough = enabled;
        SetWindowPos(Hwnd, IntPtr.Zero, 0, 0, 0, 0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }

    // ── HTTP 静态服务（引擎页要 fetch model.psd，file:// 下会被拦） ──
    static System.Net.Sockets.TcpListener TcpL = null;

    static string ResolvePageUrl()
    {
        string exeDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string pluginRoot = null;
        string d = exeDir;
        for (int i = 0; i < 5 && d != null; i++)
        {
            if (File.Exists(Path.Combine(d, "tools", "pet-page", "index.html"))) { pluginRoot = d; break; }
            d = Path.GetDirectoryName(d);
        }
        if (pluginRoot == null) { Log("plugin root NOT found from " + exeDir); return "about:blank"; }
        Log("plugin root: " + pluginRoot);
        int port = StartStaticServer(pluginRoot);
        if (port <= 0)
        {
            Log("static server failed -> file fallback");
            return new Uri(Path.Combine(pluginRoot, "tools", "pet-page", "index.html")).AbsoluteUri;
        }
        Log("static server on " + port);
        return "http://127.0.0.1:" + port + "/tools/pet-page/index.html?host=webview2";
    }

    /// <summary>主静态服务端口（0 = 没起来）。全屏弹幕页复用它，不再另开端口。</summary>
    static int StaticServerPort = 0;

    static int StartStaticServer(string root)
    {
        // HttpListener 在这台机器上抛 PlatformNotSupportedException ⇒ 用 TcpListener 手写最小 HTTP/1.1
        int[] ports = new int[] { 8611, 8612, 8613, 8614, 8615, 8616 };
        foreach (int p in ports)
        {
            try
            {
                var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, p);
                l.Start();
                TcpL = l;
                StaticServerPort = p;   // 记下来给弹幕层用
                Log("tcp listener bound on " + p);
                var th = new System.Threading.Thread(() => ServeLoopTcp(root));
                th.IsBackground = true;
                th.Start();
                return p;
            }
            catch (Exception ex) { Log("port " + p + " bind fail: " + ex.GetType().Name); }
        }
        return 0;
    }

    static void ServeLoopTcp(string root)
    {
        string rootFull = Path.GetFullPath(root);
        while (TcpL != null)
        {
            System.Net.Sockets.TcpClient cl = null;
            try
            {
                cl = TcpL.AcceptTcpClient();
                using (var ns = cl.GetStream())
                {
                    ns.ReadTimeout = 5000;
                    // 🔴🔴 2026-10-25 修的真凶：以前是
                    //       int n = ns.Read(buf, 0, buf.Length);
                    //       string req = Encoding.ASCII.GetString(buf, 0, n);
                    //    整包按 ASCII 解 —— 中文一个字都不剩，全变成 '?'（0x3F）。
                    //    所以桌宠对话框里说的话进了会话就是「?????????」，
                    //    连她自己说的话都不能是中文（日记、聊天全受影响）。
                    //    ✅ 现在：**头按 ASCII 解、体按 UTF-8 解**，
                    //       并且按 Content-Length 把请求体读全（以前只读一次 Read，
                    //       请求体跨 TCP 分段时会被截断，长消息直接丢尾巴）。
                    string reqHead;
                    byte[] reqBody;
                    if (!HttpReadRequest(ns, out reqHead, out reqBody)) { cl.Close(); continue; }
                    string req = reqHead;
                    string firstLine = req.Split('\n')[0].Trim();
                    string[] parts = firstLine.Split(' ');
                    if (parts.Length < 2) { cl.Close(); continue; }
                    string methodRaw = parts[0];
                    string pathRaw = parts[1];
                    int q = pathRaw.IndexOf('?');
                    string query = q >= 0 ? pathRaw.Substring(q) : "";
                    if (q >= 0) pathRaw = pathRaw.Substring(0, q);

                    // ⭐⭐ 同源反向代理（2026-10-25）：/api/dsh/* → DSH 宿主的 /api/*
                    //   为什么必须要有它：页面是这个 TcpListener 发的（127.0.0.1:8611），
                    //   JSON 接口在 DSH 宿主上（127.0.0.1:50898）—— 换了 origin，
                    //   浏览器按同源策略直接掐掉 fetch/XHR（页面里报 "Failed to fetch"），
                    //   表现就是主人说的「日记点击打不开」「对话没连上」。
                    //   走同源代理后**两端同一个 origin**，跨域问题从根上没了，
                    //   也不依赖 DSH 那边有没有发 CORS 头（不用重启 DSH 就生效）。
                    if (pathRaw.StartsWith("/api/dsh/", StringComparison.OrdinalIgnoreCase))
                    {
                        ProxyToDsh(ns, methodRaw, "/api/" + pathRaw.Substring("/api/dsh/".Length) + query, req, reqBody);
                        continue;
                    }

                    string rel = Uri.UnescapeDataString(pathRaw).TrimStart('/');
                    string full = Path.GetFullPath(Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar)));
                    byte[] body; int code; string ct;
                    if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) { body = Encoding.UTF8.GetBytes("403"); code = 403; ct = "text/plain"; }
                    else if (!File.Exists(full)) { body = Encoding.UTF8.GetBytes("404"); code = 404; ct = "text/plain"; }
                    else
                    {
                        body = File.ReadAllBytes(full);
                        code = 200;
                        string ext = Path.GetExtension(full).ToLowerInvariant();
                        ct = ext == ".html" ? "text/html; charset=utf-8"
                            : ext == ".js" ? "application/javascript; charset=utf-8"
                            : ext == ".css" ? "text/css; charset=utf-8"
                            : ext == ".png" ? "image/png"
                            : ext == ".json" ? "application/json; charset=utf-8"
                            : "application/octet-stream";
                    }
                    string head = "HTTP/1.1 " + code + (code == 200 ? " OK" : " ERR") + "\r\n"
                        + "Content-Type: " + ct + "\r\n"
                        + "Content-Length: " + body.Length + "\r\n"
                        + "Cache-Control: no-store\r\n"
                        // 只发页面文件，本来不需要跨域；但排障时用 curl/别页探过，
                        // 顺手放开本机回环，免得以后又误判成"跨域坏了"。
                        + "Access-Control-Allow-Origin: *\r\n"
                        + "Connection: close\r\n\r\n";
                    byte[] headB = Encoding.ASCII.GetBytes(head);
                    ns.Write(headB, 0, headB.Length);
                    ns.Write(body, 0, body.Length);
                    ns.Flush();
                }
            }
            catch (Exception ex)
            {
                if (!(ex is System.IO.IOException)) Log("serve EXC: " + ex.GetType().Name + " " + ex.Message);
            }
            finally { try { if (cl != null) cl.Close(); } catch { } }
        }
    }

    /// <summary>
    /// 读一条最小 HTTP/1.1 请求：**头按 ASCII、体按 UTF-8**，并按 Content-Length 读全。
    /// （2026-10-25：以前整包 ASCII 解 —— 中文全变 '?'，桌宠说的话进了会话是「?????」）
    /// </summary>
    static bool HttpReadRequest(System.Net.Sockets.NetworkStream ns, out string head, out byte[] body)
    {
        head = ""; body = new byte[0];
        try
        {
            var buf = new byte[8192];
            int n = ns.Read(buf, 0, buf.Length);
            if (n <= 0) return false;
            // 先把已读到的字节当成"头部 + 可能的一截体"
            int hdrEnd = -1;
            for (int i = 0; i + 3 < n; i++)
            {
                if (buf[i] == 13 && buf[i + 1] == 10 && buf[i + 2] == 13 && buf[i + 3] == 10) { hdrEnd = i + 4; break; }
            }
            // 头跨了一次 Read 的分段：继续读直到看到 \r\n\r\n（最多再读 8KB）
            while (hdrEnd < 0 && n < 16384)
            {
                int more = ns.Read(buf, n, buf.Length - n);
                if (more <= 0) break;
                n += more;
                for (int i = 0; i + 3 < n; i++)
                {
                    if (buf[i] == 13 && buf[i + 1] == 10 && buf[i + 2] == 13 && buf[i + 3] == 10) { hdrEnd = i + 4; break; }
                }
            }
            if (hdrEnd < 0) return false;
            // ⚠️ HTTP 头一定是 ASCII/拉丁字母，body 才是 UTF-8 —— 分开解
            head = Encoding.ASCII.GetString(buf, 0, hdrEnd);

            // Content-Length
            int contentLen = 0;
            int clAt = head.IndexOf("\r\nContent-Length:", StringComparison.OrdinalIgnoreCase);
            if (clAt >= 0)
            {
                int numStart = clAt + "\r\nContent-Length:".Length;
                int numEnd = head.IndexOf("\r\n", numStart);
                if (numEnd < 0) numEnd = head.Length;
                int.TryParse(head.Substring(numStart, numEnd - numStart).Trim(), out contentLen);
            }
            if (contentLen < 0) contentLen = 0;
            if (contentLen > 1024 * 1024) contentLen = 1024 * 1024;   // 1MB 上限，别被撑爆

            var bodyBuf = new byte[contentLen];
            int got = Math.Min(contentLen, n - hdrEnd);
            if (got > 0) Array.Copy(buf, hdrEnd, bodyBuf, 0, got);
            // 体跨段：把剩下的按 Content-Length 读全（以前只读一次 Read ⇒ 长消息被截断）
            while (got < contentLen)
            {
                int more = ns.Read(bodyBuf, got, contentLen - got);
                if (more <= 0) break;
                got += more;
            }
            body = bodyBuf;
            if (got < contentLen) Log("http: 请求体只收到 " + got + "/" + contentLen + " 字节（对方提前关了）");
            return true;
        }
        catch (Exception ex) { Log("http read EXC: " + ex.GetType().Name + " " + ex.Message); return false; }
    }

    /// <summary>
    /// 把 /api/dsh/* 转发给 DSH 宿主（同源代理，治跨域）。
    /// 只转发到本机回环，只认 /api/ 前缀 —— 别把它做成一台开放代理。
    /// </summary>
    /// <param name="rawBody">请求体原始字节（**已经是 UTF-8**，别再解一次）</param>
    static void ProxyToDsh(System.Net.Sockets.NetworkStream ns, string method, string targetPath, string rawReq, byte[] rawBody)
    {
        try
        {
            string api = ApiBase();                       // 例如 http://127.0.0.1:50898/api/douyin-duty
            if (string.IsNullOrEmpty(api)) { WritePlain(ns, 503, "no api base"); return; }
            var u = new Uri(api);
            // 目标：{scheme}://{host}:{port}{apiPath 去掉末尾 /api/douyin-duty 之类} + targetPath
            // ApiBase 形如 http://host:port/api/douyin-duty ⇒ 根是 /api
            string apiPath = u.AbsolutePath;               // /api/douyin-duty
            string rootless = apiPath;
            int cut = rootless.IndexOf("/api/", StringComparison.OrdinalIgnoreCase);
            string apiRoot = cut >= 0 ? rootless.Substring(0, cut) : "";   // "" （/api 之前）
            // targetPath 形如 /api/douyin-duty/pet/diary —— 已经带全，直接用
            string fullPath = targetPath;
            if (!string.IsNullOrEmpty(apiRoot) && !fullPath.StartsWith(apiRoot, StringComparison.OrdinalIgnoreCase))
                fullPath = apiRoot + targetPath;

            // 请求体：直接用调用方读全的**原始字节**（UTF-8）。
            // 🔴 以前是 `bodyText = rawReq.Substring(hdrEnd+4)` 再 GetBytes(UTF8) —— 而 rawReq
            //    本身是 ASCII 解的，中文早在解的时候就已经变成 '?'，再编回 UTF-8 也只是
            //    "?????????" 的 UTF-8 编码。这就是桌宠说的话进会话全是问号的根。
            byte[] bodyBytes = rawBody ?? new byte[0];

            var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(u.Scheme + "://" + u.Host + ":" + u.Port + fullPath);
            req.Method = method;
            req.ContentType = "application/json; charset=utf-8";
            req.Timeout = 15000;
            req.ReadWriteTimeout = 15000;
            // 不要把浏览器自己的 Origin/Host 转过去（会触发 DSH 侧校验）；同源由本代理负责
            req.Host = u.IsDefaultPort ? u.Host : (u.Host + ":" + u.Port);
            if (bodyBytes.Length > 0)
            {
                req.ContentLength = bodyBytes.Length;
                using (var rs = req.GetRequestStream()) { rs.Write(bodyBytes, 0, bodyBytes.Length); }
            }
            else if (method == "POST") req.ContentLength = 0;

            using (var resp = (System.Net.HttpWebResponse)req.GetResponse())
            {
                byte[] outBody;
                using (var ms = new System.IO.MemoryStream())
                {
                    resp.GetResponseStream().CopyTo(ms);
                    outBody = ms.ToArray();
                }
                int code = (int)resp.StatusCode;
                string head = "HTTP/1.1 " + code + " OK\r\n"
                    + "Content-Type: " + (resp.ContentType ?? "application/json; charset=utf-8") + "\r\n"
                    + "Content-Length: " + outBody.Length + "\r\n"
                    + "Cache-Control: no-store\r\n"
                    // 同源了本来不需要，带着无害（万一有人从别的页直连）
                    + "Access-Control-Allow-Origin: *\r\n"
                    + "Connection: close\r\n\r\n";
                byte[] hb = Encoding.ASCII.GetBytes(head);
                ns.Write(hb, 0, hb.Length);
                ns.Write(outBody, 0, outBody.Length);
                ns.Flush();
            }
        }
        catch (System.Net.WebException wex)
        {
            try
            {
                var r = wex.Response as System.Net.HttpWebResponse;
                if (r != null)
                {
                    Log("proxy upstream " + (int)r.StatusCode + " for " + targetPath);
                    WritePlain(ns, (int)r.StatusCode, "upstream " + (int)r.StatusCode);
                }
                else { Log("proxy web EXC: " + wex.Message); WritePlain(ns, 502, "proxy error"); }
            }
            catch { }
        }
        catch (Exception ex)
        {
            Log("proxy EXC: " + ex.GetType().Name + ": " + ex.Message);
            try { WritePlain(ns, 502, "proxy error"); } catch { }
        }
    }

    static void WritePlain(System.Net.Sockets.NetworkStream ns, int code, string text)
    {
        byte[] b = Encoding.UTF8.GetBytes(text ?? "");
        string head = "HTTP/1.1 " + code + " ERR\r\n"
            + "Content-Type: text/plain; charset=utf-8\r\n"
            + "Content-Length: " + b.Length + "\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Connection: close\r\n\r\n";
        byte[] hb = Encoding.ASCII.GetBytes(head);
        ns.Write(hb, 0, hb.Length);
        ns.Write(b, 0, b.Length);
        ns.Flush();
    }

    static bool WvInitStarted = false;

    static void InitWebViewAsync()
    {
        if (WvInitStarted) { Log("init skipped (already started)"); return; }
        WvInitStarted = true;
        string exeDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string udf = Path.Combine(exeDir, "pet-udf");
        try
        {
            if (!Directory.Exists(udf)) Directory.CreateDirectory(udf);
            Log("udf ready: " + udf);
        }
        catch (Exception ex) { Log("udf create EXC: " + ex.Message); }

        var opts = new CoreWebView2EnvironmentOptions(
            "--autoplay-policy=no-user-gesture-required --disable-features=Translate,msSmartScreenProtection");
        Log("creating env");
        CoreWebView2Environment.CreateAsync(null, udf, opts).ContinueWith(t =>
        {
            if (t.IsFaulted) { Log("env FAULT: " + t.Exception.GetBaseException().Message); return; }
            Log("env ready");
            var env = t.Result;
            Win.Dispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    Log("ensuring core (composition)");
                    Wv.EnsureCoreWebView2Async(env).ContinueWith(t2 =>
                    {
                        if (t2.IsFaulted) { Log("core FAULT: " + t2.Exception.GetBaseException().Message); return; }
                        Log("core ready");
                        Win.Dispatcher.BeginInvoke(new Action(() =>
                        {
                            try { AfterCoreReady(); }
                            catch (Exception ex) { Log("post-core EXC: " + ex.Message + "\n" + ex.StackTrace); }
                        }), DispatcherPriority.Background);
                    });
                }
                catch (Exception ex) { Log("ensure EXC: " + ex.Message); }
            }), DispatcherPriority.Background);
        });
    }

    static void AfterCoreReady()
    {
        CoreReady = true;
        var core = Wv.CoreWebView2;
        // ② 显式再设一次全透明（环境变量那一步只保证浏览器进程启动时是透明）
        Wv.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0, 0, 0, 0);
        Log("DefaultBackgroundColor=A0 background=" + Wv.DefaultBackgroundColor);

        var st = core.Settings;
        st.AreDefaultContextMenusEnabled = false;   // 右键走宿主原生菜单
        st.IsStatusBarEnabled = false;
        st.AreDevToolsEnabled = true;
        st.IsZoomControlEnabled = false;

        // ③ 页面 CSS 落地之前先钉死透明底，避免闪一块白/黑底
        try
        {
            core.AddScriptToExecuteOnDocumentCreatedAsync(
                "try{var s=document.createElement('style');" +
                "s.textContent='html,body{background:transparent!important}';" +
                "(document.head||document.documentElement).appendChild(s);}catch(e){}");
            Log("transparent style injection registered");
        }
        catch (Exception ex) { Log("inject EXC: " + ex.Message); }

        core.WebMessageReceived += (s, e) =>
        {
            try
            {
                string msg = e.TryGetWebMessageAsString();
                if (string.IsNullOrEmpty(msg)) return;
                if (msg.StartsWith("cmd:"))
                {
                    string json = msg.Substring(4);
                    Log("cmd from page: " + json);
                    WriteCmd(json);
                }
                else if (msg == "pet:drag")
                {
                    // ⑤ 拖动交给系统：release capture 后假装按住标题栏，系统给原生移动循环
                    Win.Dispatcher.BeginInvoke(new Action(() =>
                    {
                        try
                        {
                            Dragging = true;
                            ClickThroughTimer.Stop();
                            SetClickThrough(false);
                            if (Hwnd == IntPtr.Zero) Hwnd = new WindowInteropHelper(Win).Handle;
                            ReleaseCapture();
                            SendMessage(Hwnd, WM_NCLBUTTONDOWN, new IntPtr(HTCAPTION), IntPtr.Zero);
                        }
                        catch (Exception ex2) { Log("drag EXC: " + ex2.Message); }
                        finally
                        {
                            Dragging = false;
                            // 🔴 拖完先夹回工作区再存（系统拖动允许把她拖出屏幕边缘，
                            //    拖着的时候不管，松手必须拉回来，否则下次启动就在屏幕外）
                            ClampIntoWorkArea();
                            SavePos();
                            ClickThroughTimer.Start();
                            Log("drag done pos=" + (int)Win.Left + "," + (int)Win.Top);
                        }
                    }));
                }
                else if (msg == "pet:menu")
                {
                    Log("menu requested from page");
                    Win.Dispatcher.BeginInvoke(new Action(() => { try { ShowNativeMenu(); } catch (Exception ex2) { Log("menu EXC: " + ex2.Message); } }));
                }
                else if (msg == "pet:quit" || msg == "pet:hide")
                {
                    // 🔴 主人「点退出没反应」：WebView2 里 window.close() 是空操作，页面关不掉。
                    //    改成页面只喊一声，**宿主自己关窗**。先等一拍让 pet-cmd.json 落盘，
                    //    否则 keeper 可能还没读到命令窗口就没了。
                    bool isQuit = (msg == "pet:quit");
                    Log((isQuit ? "quit" : "hide") + " requested from page -> closing window");
                    Win.Dispatcher.BeginInvoke(new Action(() =>
                    {
                        var t = new DispatcherTimer();
                        t.Interval = TimeSpan.FromMilliseconds(450);
                        t.Tick += (s3, e3) =>
                        {
                            t.Stop();
                            try { SavePos(); } catch { }
                            Log("closing window now (" + (isQuit ? "quit" : "hide") + ")");
                            try { Win.Close(); } catch (Exception ex3) { Log("close EXC: " + ex3.Message); }
                        };
                        t.Start();
                    }));
                }
                else if (msg.StartsWith("pet:box:") || msg.StartsWith("pet:ui:"))
                {
                    OnHitRects(msg);
                }
                else if (msg == "pet:focus")
                {
                    // 🔴 主人「输入框点击之后依旧没对话」：分层透明窗默认拿不到键盘焦点。
                    //    页面点进输入框时喊这一声，宿主主动把自己激活（并把焦点交给 WebView），
                    //    键盘事件才真的进得去。失焦由页面发 pet:blur 交回。
                    // ⚠️ 必须防抖：Activate 会让页面再次触发 focus ⇒ 又发 pet:focus ⇒ 死循环
                    //    （实测每秒刷 7 次、日志被 pet:focus 冲满）。同一状态 600ms 内只处理一次。
                    long nowTicks = DateTime.UtcNow.Ticks;
                    if (nowTicks - LastFocusAt < TimeSpan.TicksPerMillisecond * 600) return;
                    LastFocusAt = nowTicks;
                    Win.Dispatcher.BeginInvoke(new Action(() =>
                    {
                        try
                        {
                            if (Win.IsActive) { Log("pet:focus -> already active, skip"); return; }
                            if (Win.WindowState == WindowState.Minimized) Win.WindowState = WindowState.Normal;
                            Win.Activate();
                            Win.Topmost = true;
                            try { Wv.Focus(); } catch { }
                            Log("pet:focus -> activated");
                        }
                        catch (Exception exf) { Log("focus EXC: " + exf.Message); }
                    }));
                }
                else if (msg == "pet:blur")
                {
                    Log("pet:blur -> page 放弃焦点");
                }
                else if (msg.StartsWith("pet:danmaku:"))
                {
                    // 主人 2026-10-25：「我要的是全屏弹幕跟局域弹幕」
                    //   full  ⇒ 开独立全屏覆盖窗；local/off ⇒ 关掉那个窗（局域在她自己窗口里画）
                    string m = msg.Substring("pet:danmaku:".Length);
                    DanmakuMode = (m == "full") ? "full" : (m == "local" ? "local" : "off");
                    Log("danmaku mode -> " + DanmakuMode);
                    Win.Dispatcher.BeginInvoke(new Action(() =>
                    {
                        try { EnsureDanmakuWindow(DanmakuMode == "full"); } catch (Exception exd) { Log("danmaku toggle EXC: " + exd.Message); }
                        try { PushDanmakuMode(); } catch { }
                    }));
                }
                else if (msg.StartsWith("pet:persona:"))
                {
                    DanmakuPersona = msg.Substring("pet:persona:".Length);
                    Log("persona -> " + DanmakuPersona + "（全屏弹幕台词跟着换）");
                    try { PushDanmakuMode(); } catch { }
                }
                else if (msg.StartsWith("pixels:"))
                {
                    Log("pixels: " + msg.Substring(7));
                }
                else if (msg.StartsWith("sfx:"))
                {
                    Log("sfx: " + msg.Substring(4));
                }
            }
            catch (Exception ex4) { Log("msg EXC: " + ex4.Message); }
        };

        core.NavigationCompleted += (s2, e2) =>
        {
            Log("nav completed ok=" + e2.IsSuccess);
            // ⭐ 把窗口几何注给页面（主人 2026-10-25「文本框显示不完全」的配套）：
            //    页面要靠 --bubble-band 算画布边长 = 窗口高 - 气泡带。
            //    不注进去，页面就不知道上面那 170px 是气泡专用的，会按整窗算尺寸 ⇒ 人物变形。
            try
            {
                string geo = "try{document.documentElement.style.setProperty('--bubble-band','" + BubbleBand + "px');" +
                             "document.documentElement.style.setProperty('--canvas-w','" + CanvasW + "px');" +
                             "document.documentElement.style.setProperty('--foot-gap','" + FootGap + "px');" +
                             "window.__petLayout && window.__petLayout();}catch(e){}";
                core.ExecuteScriptAsync(geo).ContinueWith(tg =>
                {
                    try { Log("geometry injected: canvas=" + CanvasW + " band=" + BubbleBand + " foot=" + FootGap + " win=" + WW + "x" + WH); } catch { }
                });
            }
            catch (Exception exg) { Log("geometry inject EXC: " + exg.Message); }
            var probeTask = core.ExecuteScriptAsync(
                "JSON.stringify({gl:!!document.getElementById('gl'),err:((document.getElementById('load-error')||{}).textContent||'')," +
                "w:((document.getElementById('gl')||{}).width||0),bg:getComputedStyle(document.body).backgroundColor," +
                "vw:innerWidth,vh:innerHeight,dpr:devicePixelRatio,act:typeof window.__petAct})");
            probeTask.ContinueWith(t3 => { Log("probe: " + (t3.IsFaulted ? "FAULT" : t3.Result)); });
        };

        string url = ResolvePageUrl();
        Log("navigating: " + url);
        Wv.Source = new Uri(url);
    }

    // ══════════════════════════════════════════════════════════════
    // 全屏弹幕层（主人 2026-10-25：「我要的是全屏弹幕跟局域弹幕，
    //   但是你好像都用一个窗口画了，属于局域内的窗口」）
    // ──────────────────────────────────────────────────────────────
    // 单独开一个**覆盖整块屏幕**的窗口，专门画弹幕：
    //   · 全屏弹幕 ⇒ 这个窗显示（铺满屏幕，弹幕从右边飘到左边）
    //   · 局域弹幕 ⇒ 这个窗隐藏，弹幕在她自己窗口里飘（跟着她走）
    // 关键点是这个窗必须**点击穿透**（WS_EX_TRANSPARENT），否则满屏的弹幕层会把
    // 桌面和所有应用都挡住点不了 —— 这是全屏 overlay 最大的坑。
    // 复用同一个 WebView2 user data folder 会 0x800700AA，所以它用**自己的 udf**。
    public static Window DanmakuWin;
    public static WebView2CompositionControl DanmakuWv;
    static System.Net.Sockets.TcpListener DanmakuTcpL = null;

    // ── 日记本窗口（主人 2026-10-25：「日记要不要弄个简单的阅读页面弄成日记本的形状」）──
    //    跟弹幕层相反：这是个**要能读、能点、能翻页**的普通窗，不做点击穿透、不做透明。
    //    udf 单独一份，理由同上（同一 udf 复用到两个控件会 0x800700AA）。
    public static Window DiaryWin;
    public static WebView2CompositionControl DiaryWv;
    static bool DiaryWvInitStarted = false;

    /// <summary>开/关日记本。已开着就关掉（同一个菜单项当成开关用）。</summary>
    static void ToggleDiaryWindow()
    {
        try
        {
            if (DiaryWin != null)
            {
                Log("diary window -> close (toggle)");
                try { DiaryWin.Close(); } catch { }
                DiaryWin = null; DiaryWv = null; DiaryWvInitStarted = false;
                return;
            }
            BuildDiaryWindow();
        }
        catch (Exception ex) { Log("diary win EXC: " + ex.Message); }
    }

    static void BuildDiaryWindow()
    {
        var wa = SystemParameters.WorkArea;
        double w = Math.Min(1000, wa.Width - 60);
        double h = Math.Min(700, wa.Height - 60);
        DiaryWin = new Window();
        DiaryWin.WindowStyle = WindowStyle.SingleBorderWindow;
        DiaryWin.ResizeMode = ResizeMode.CanResize;
        DiaryWin.Title = "她的日记本";
        DiaryWin.Width = w;
        DiaryWin.Height = h;
        DiaryWin.Left = wa.Left + (wa.Width - w) / 2;
        DiaryWin.Top = wa.Top + (wa.Height - h) / 2;
        DiaryWin.ShowInTaskbar = false;
        DiaryWin.Topmost = true;
        // 本子底色深一点，跟页面里那张深色"桌子"接得上
        DiaryWin.Background = new SolidColorBrush(Color.FromRgb(36, 31, 26));

        DiaryWv = new WebView2CompositionControl();
        DiaryWv.AllowExternalDrop = false;
        DiaryWv.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0, 0, 0, 0);
        DiaryWin.Content = DiaryWv;

        DiaryWin.Closed += (s, e) =>
        {
            Log("diary window closed");
            DiaryWin = null; DiaryWv = null; DiaryWvInitStarted = false;
        };
        DiaryWin.Show();
        Log("diary window shown " + (int)w + "x" + (int)h);

        if (DiaryWvInitStarted) return;
        DiaryWvInitStarted = true;
        string exeDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string udf = Path.Combine(exeDir, "pet-udf-diary");
        try { if (!Directory.Exists(udf)) Directory.CreateDirectory(udf); } catch { }
        var opts = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
        CoreWebView2Environment.CreateAsync(null, udf, opts).ContinueWith(t =>
        {
            if (t.IsFaulted) { Log("diary env FAULT: " + t.Exception.GetBaseException().Message); return; }
            var env = t.Result;
            if (DiaryWin == null || DiaryWv == null) return;
            DiaryWin.Dispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    DiaryWv.EnsureCoreWebView2Async(env).ContinueWith(t2 =>
                    {
                        if (t2.IsFaulted) { Log("diary core FAULT: " + t2.Exception.GetBaseException().Message); return; }
                        if (DiaryWin == null || DiaryWv == null) return;
                        DiaryWin.Dispatcher.BeginInvoke(new Action(() =>
                        {
                            try
                            {
                                var st = DiaryWv.CoreWebView2.Settings;
                                st.AreDefaultContextMenusEnabled = false;
                                st.IsStatusBarEnabled = false;
                                st.AreDevToolsEnabled = false;
                                DiaryWv.CoreWebView2.NavigationCompleted += (s3, e3) =>
                                    Log("diary nav completed ok=" + e3.IsSuccess);
                                // 页面喊 diary:close（按 Esc）⇒ 宿主自己关（WebView2 里 window.close() 是空操作）
                                DiaryWv.CoreWebView2.WebMessageReceived += (s4, e4) =>
                                {
                                    try
                                    {
                                        string dm = e4.TryGetWebMessageAsString();
                                        if (string.IsNullOrEmpty(dm)) return;
                                        Log("diary page: " + dm);
                                        if (dm == "diary:close" && DiaryWin != null)
                                            DiaryWin.Dispatcher.BeginInvoke(new Action(() => { try { DiaryWin.Close(); } catch { } }));
                                    }
                                    catch { }
                                };
                                int port = StaticServerPort;
                                if (port <= 0) { Log("diary: 主静态服务未就绪（StaticServerPort=0）"); return; }
                                // 把接口地址直接写进 URL：页面不用猜后端在哪（跨域已由宿主侧 CORS 放行）
                                string api = ApiBase();
                                string url = "http://127.0.0.1:" + port + "/tools/pet-page/diary.html"
                                    + (string.IsNullOrEmpty(api) ? "" : ("?api=" + Uri.EscapeDataString(api)));
                                Log("diary navigating: " + url);
                                DiaryWv.Source = new Uri(url);
                            }
                            catch (Exception ex3) { Log("diary post-core EXC: " + ex3.Message); }
                        }));
                    });
                }
                catch (Exception ex2) { Log("diary ensure EXC: " + ex2.Message); }
            }));
        });
    }

    /// <summary>从状态文件里读 api 基址（页面和日记本都靠它找后端）。</summary>
    static string ApiBase()
    {
        try
        {
            if (!File.Exists(StateFile)) return "";
            string txt = File.ReadAllText(StateFile, Encoding.UTF8).TrimStart('\uFEFF');
            var j = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(txt);
            if (j != null && j.ContainsKey("api") && j["api"] is string) return (string)j["api"];
        }
        catch { }
        return "";
    }

    // ── 父进程监视：DSH 一退，她也跟着退 ─────────────────────────────────────
    // 主人 2026-10-25：「关闭 DSH 没有关闭宠物面板」。
    // 记录起我时的父进程 pid，每 2 秒看它还在不在；连续 3 次都查不到才退。
    //
    // 🔴 踩过的雷（第一次就是这样把自己秒关了）：判活**不能用 Process.GetProcessById**。
    //    父进程（Electron 主进程）句柄权限受限时，GetProcessById 会抛
    //    "Access is denied"（Win32Exception），我当时 catch 之后一律当成"进程没了"，
    //    结果 she 一启动就把自己判死（日志：parent pid=1820 gone -> exit now，而 1820 活得好好的）。
    //    正解：用 Win32 OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION) 判活，
    //    拿不到权限时返回 ERROR_ACCESS_DENIED(5) —— **有权限错误 = 进程存在**，不能算死。
    static int ParentPid = 0;
    static int ParentMisses = 0;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);
    const uint SYNCHRONIZE = 0x00100000;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const int ERROR_ACCESS_DENIED = 5;

    /// <summary>父进程还活着吗。只有"确实不存在"(ERROR_INVALID_PARAMETER) 才算死。</summary>
    static bool ParentAlive()
    {
        IntPtr h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)ParentPid);
        if (h != IntPtr.Zero)
        {
            try
            {
                // 句柄拿到了再看它有没有真的退出（pid 可能被复用）
                using (var p = Process.GetProcessById(ParentPid))
                {
                    if (p.HasExited) return false;
                }
            }
            catch
            {
                // GetProcessById 出错但句柄是有效的 ⇒ 进程在，只是查询受限
                return true;
            }
            finally { CloseHandle(h); }
            return true;
        }
        int err = Marshal.GetLastWin32Error();
        // 没有权限 ≠ 不存在（这是本机进程，权限错误说明它还占着 pid）
        if (err == ERROR_ACCESS_DENIED) return true;
        return false;
    }

    /// <summary>抓父进程 pid。取不到就返回 false（那就退化成只靠状态文件）。</summary>
    static bool ResolveParentPid()
    {
        try
        {
            // 优先用 WMI 查真正的父进程（比 "父 pid = 我 pid" 那套猜测可靠得多）
            string q = "SELECT ParentProcessId FROM Win32_Process WHERE ProcessId = " + Process.GetCurrentProcess().Id;
            var mo = new System.Management.ManagementObjectSearcher(q);
            foreach (System.Management.ManagementObject o in mo.Get())
            {
                object v = o["ParentProcessId"];
                if (v != null) { int pid = Convert.ToInt32(v); if (pid > 0) { ParentPid = pid; return true; } }
            }
        }
        catch (Exception ex) { Log("parent pid resolve EXC: " + ex.Message); }
        return false;
    }

    static void StartParentWatch()
    {
        try
        {
            if (!ResolveParentPid())
            {
                Log("parent watch: 拿不到父 pid，退化为只靠状态文件");
                return;
            }
            if (ParentPid <= 4) { Log("parent watch: 父 pid 可疑(" + ParentPid + ")，不启用"); return; }
            Log("parent watch: parent pid=" + ParentPid);
            var t = new DispatcherTimer();
            t.Interval = TimeSpan.FromSeconds(2);
            t.Tick += (s, e) =>
            {
                try
                {
                    if (ParentAlive()) { ParentMisses = 0; return; }
                    ParentMisses++;
                    if (ParentMisses < 3) return;   // 连续 3 次（≈6 秒）都确认没了才动手
                    Log("parent pid=" + ParentPid + " gone -> exit now");
                    try { if (DiaryWin != null) DiaryWin.Close(); } catch { }
                    try
                    {
                        foreach (Window w in Application.Current.Windows) { try { w.Close(); } catch { } }
                    }
                    catch { }
                    try { Application.Current.Shutdown(0); } catch { }
                }
                catch (Exception ex2) { Log("parent watch EXC: " + ex2.Message); }
            };
            t.Start();
        }
        catch (Exception ex) { Log("parent watch start EXC: " + ex.Message); }
    }

    static void EnsureDanmakuWindow(bool show)
    {
        try
        {
            if (show)
            {
                if (DanmakuWin != null) { DanmakuWin.Show(); DanmakuWin.Topmost = true; return; }
                BuildDanmakuWindow();
            }
            else
            {
                if (DanmakuWin != null) { DanmakuWin.Hide(); Log("danmaku overlay hidden"); }
            }
        }
        catch (Exception ex) { Log("danmaku win EXC: " + ex.Message); }
    }

    static void BuildDanmakuWindow()
    {
        var wa = SystemParameters.WorkArea;
        DanmakuWin = new Window();
        DanmakuWin.WindowStyle = WindowStyle.None;
        DanmakuWin.AllowsTransparency = true;
        DanmakuWin.Background = Brushes.Transparent;
        DanmakuWin.Topmost = true;
        DanmakuWin.ShowInTaskbar = false;
        DanmakuWin.ShowActivated = false;   // 弹幕层永不抢焦点
        DanmakuWin.ResizeMode = ResizeMode.NoResize;
        DanmakuWin.Left = wa.Left;
        DanmakuWin.Top = wa.Top;
        DanmakuWin.Width = wa.Width;
        DanmakuWin.Height = wa.Height;
        DanmakuWin.Title = "deskpet-danmaku";

        DanmakuWv = new WebView2CompositionControl();
        DanmakuWv.AllowExternalDrop = false;
        DanmakuWin.Content = DanmakuWv;

        DanmakuWin.SourceInitialized += (s, e) =>
        {
            try
            {
                var h = new WindowInteropHelper(DanmakuWin).Handle;
                // ① TOOLWINDOW：不进 Alt+Tab
                long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
                ex |= WS_EX_TOOLWINDOW;
                // ② 🔴 TRANSACTION：整个弹幕层点击穿透，否则满屏挡死所有应用
                ex |= WS_EX_TRANSPARENT;
                ex |= WS_EX_NOACTIVATE;
                SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(ex));
                SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0,
                    SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
                Log("danmaku overlay ex=0x" + GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64().ToString("X8")
                    + " screen=" + (int)wa.Width + "x" + (int)wa.Height);
            }
            catch (Exception ex2) { Log("danmaku style EXC: " + ex2.Message); }
        };
        DanmakuWin.Show();
        Log("danmaku overlay shown " + (int)wa.Width + "x" + (int)wa.Height);

        string exeDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string udf = Path.Combine(exeDir, "pet-udf-danmaku");
        try { if (!Directory.Exists(udf)) Directory.CreateDirectory(udf); } catch { }
        var opts = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
        CoreWebView2Environment.CreateAsync(null, udf, opts).ContinueWith(t =>
        {
            if (t.IsFaulted) { Log("danmaku env FAULT: " + t.Exception.GetBaseException().Message); return; }
            DanmakuWin.Dispatcher.BeginInvoke(new Action(() =>
            {
                DanmakuWv.EnsureCoreWebView2Async(t.Result).ContinueWith(t2 =>
                {
                    if (t2.IsFaulted) { Log("danmaku core FAULT: " + t2.Exception.GetBaseException().Message); return; }
                    DanmakuWin.Dispatcher.BeginInvoke(new Action(() =>
                    {
                        try
                        {
                            DanmakuWv.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0, 0, 0, 0);
                            var st = DanmakuWv.CoreWebView2.Settings;
                            st.AreDefaultContextMenusEnabled = false;
                            st.IsStatusBarEnabled = false;
                            st.AreDevToolsEnabled = false;
                            DanmakuWv.CoreWebView2.NavigationCompleted += (s3, e3) =>
                            {
                                Log("danmaku nav completed ok=" + e3.IsSuccess);
                                // 立刻告诉她当前该不该显示弹幕
                                PushDanmakuMode();
                            };
                            // 弹幕页回报状态（链路自证：页面真的起来、模式真的切了）
                            DanmakuWv.CoreWebView2.WebMessageReceived += (s4, e4) =>
                            {
                                try
                                {
                                    string dm = e4.TryGetWebMessageAsString();
                                    if (!string.IsNullOrEmpty(dm)) Log("danmaku page: " + dm);
                                }
                                catch { }
                            };
                            // 🔴 复用**主静态服务**（8611 那条，它的根就是插件根）：
                            //    实测 8611 能直接取到 danmaku.html，没必要为弹幕层再开一个端口
                            //    —— 独立端口意味着还要再写一套一模一样的 TcpListener 循环。
                            int port = StaticServerPort;
                            if (port <= 0) { Log("danmaku: 主静态服务未就绪（StaticServerPort=0）"); return; }
                            string url = "http://127.0.0.1:" + port + "/tools/pet-page/danmaku.html";
                            Log("danmaku navigating: " + url);
                            DanmakuWv.Source = new Uri(url);
                        }
                        catch (Exception ex3) { Log("danmaku post-core EXC: " + ex3.Message); }
                    }), DispatcherPriority.Background);
                });
            }), DispatcherPriority.Background);
        });
    }

    /// <summary>把"现在该显示什么弹幕"推给全屏弹幕页：mode = 'full' 才铺满，其它一律空。</summary>
    static void PushDanmakuMode()
    {
        try
        {
            if (DanmakuWv == null || DanmakuWv.CoreWebView2 == null) return;
            string mode = DanmakuMode;
            string persona = DanmakuPersona ?? "infp";
            DanmakuWv.CoreWebView2.ExecuteScriptAsync(
                "window.__dmSetMode && window.__dmSetMode(" + JsString(mode) + "," + JsString(persona) + ");");
        }
        catch { }
    }

    /// <summary>上次处理 pet:focus 的时刻（防抖，防 Activate ↔ focus 死循环）。</summary>
    static long LastFocusAt = 0;

    /// <summary>当前弹幕模式：'off' | 'local' | 'full'。由页面经 pet-cmd 同步过来。</summary>
    static string DanmakuMode = "off";
    static string DanmakuPersona = "infp";

    // ── ⑥ 原生右键菜单：点完把 act 回灌给页面执行（页面 doAction 是唯一实现） ──
    // 🔴 2026-10-25 主人：「人格应该有二级选项可以选择」
    //    原来只有一项「人格：下一任」，点一次循环换一个 —— 看不到有哪几种，也无法直选。
    //    现在人格做成**子菜单**：4 个档案一览无遗，点哪个换哪个。
    //    弹幕同理（主人要求区分全屏/局域），也做成子菜单。
    static void ShowNativeMenu()
    {
        var menu = new ContextMenu();
        menu.Placement = System.Windows.Controls.Primitives.PlacementMode.MousePoint;
        menu.PlacementTarget = Win;
        menu.StaysOpen = false;

        Action<string, string> addAct = (text, act) =>
        {
            var mi = new MenuItem();
            mi.Header = text;
            mi.Click += (s, e) => SendAct(act);
            menu.Items.Add(mi);
        };
        // 子菜单：text -> [(label, act)]
        Action<string, string[][]> addSub = (title, items) =>
        {
            var root = new MenuItem();
            root.Header = title;
            foreach (var pair in items)
            {
                var mi = new MenuItem();
                mi.Header = pair[0];
                string act = pair[1];
                mi.Click += (s, e) => SendAct(act);
                root.Items.Add(mi);
            }
            menu.Items.Add(root);
        };

        addAct("跟她聊天", "chat");
        addAct("喂饭（大白饭）", "feed");
        addAct("维修工模式", "repair");
        menu.Items.Add(new Separator());
        addAct("逗她（随机小动作）", "play");
        // ⭐ 弹幕：两种（主人 2026-10-25 要求区分）
        //    + 弹幕聊天模式（主人当晚第 6 条：「我输入对话，她就用弹幕回我」）
        addSub("弹幕", new string[][]
        {
            new string[] { "全屏弹幕（铺满整个屏幕）", "danmaku-full" },
            new string[] { "局域弹幕（只在她身边）", "danmaku-local" },
            new string[] { "关掉弹幕", "danmaku-off" },
            new string[] { "—— 弹幕聊天模式（她回你用弹幕滚）", "chat-danmaku" },
        });
        // ⭐ 人格：二级，4 个档案直选（主人 2026-10-25 要求）
        addSub("人格", new string[][]
        {
            new string[] { "INFP · 治愈小鱼（温柔）", "persona-infp" },
            new string[] { "ENTP · 毒舌本鱼（嘴毒）", "persona-entp" },
            new string[] { "ESFP · 元气小鱼（活泼）", "persona-esfp" },
            new string[] { "ISTJ · 维修工小鱼（认真）", "persona-istj" },
        });
        // ⭐ 2026-10-25 深夜 主人：
        //    「4最低排按钮要可以隐藏」→ 这条就是那个隐藏开关（藏了还能叫回来）
        //    「你能接入语音输出吗…语音输出要跟嘴型对上」→ 语音开关
        menu.Items.Add(new Separator());
        addAct("🔊 语音：开/关（她出声，嘴型跟上）", "voice");
        addAct("⌄ 显示/隐藏底部按钮条", "toolbar-toggle");
        menu.Items.Add(new Separator());
        addAct("去休息（面板可叫回）", "hide");
        addAct("退出（关掉她）", "quit");
        menu.Items.Add(new Separator());
        // ⭐ 彩蛋（主人 2026-10-25：「日记功能我要的是彩蛋形式，只在右键宠物的时候有
        //    这个选项，插件面板要保持干净」）—— 放最底下、不显眼，像个只有主人知道的小秘密。
        addAct("📔 她的日记（今天记了什么）", "diary");
        menu.IsOpen = true;
        Log("native menu opened items=" + menu.Items.Count);
    }

    /// <summary>把动作回灌给页面 —— 页面里的 doAction() 是唯一实现，不重复写逻辑。</summary>
    static void SendAct(string act)
    {
        try
        {
            // ⭐ 日记是**宿主动作**：要开一个真正的阅读窗（日记本），
            //    页面里没有窗口能力，所以这一条不往页面发，宿主自己办。
            //    主人 2026-10-25：「日记点击打不开，日记要不要弄个简单的阅读页面弄成日记本的形状」
            if (act == "diary") { ToggleDiaryWindow(); return; }
            if (Wv == null || Wv.CoreWebView2 == null) return;
            string js = "window.__petAct && window.__petAct(" + JsString(act) + ");";
            Log("send act: " + act);
            Wv.CoreWebView2.ExecuteScriptAsync(js);
        }
        catch (Exception ex) { Log("SendAct EXC: " + ex.Message); }
    }

    /// <summary>页面动作 → 写 pet-cmd.json，keeper 下一拍（≤10 秒）读它并应用配置。</summary>
    static void WriteCmd(string json)
    {
        try
        {
            var ser = new JavaScriptSerializer();
            var obj = ser.Deserialize<Dictionary<string, object>>(json);
            if (obj == null) { Log("WriteCmd: 空对象"); return; }
            obj["at"] = DateTime.UtcNow.ToString("o");
            string path = Path.Combine(Home, "pet-cmd.json");
            string text = ser.Serialize(obj);
            // 🔴 2026-10-25：DSH 那边（keeper 的 petApplyCmd）同一时刻在**读并删**这个文件，
            //    直接写会撞 "访问被拒绝"（实测连报 5 次）。重试 6 次、每次隔 60ms 基本都能进去。
            bool ok = false;
            for (int i = 0; i < 6 && !ok; i++)
            {
                try
                {
                    File.WriteAllText(path, text, new UTF8Encoding(false));   // 无 BOM（Node 读）
                    ok = true;
                }
                catch (IOException) { System.Threading.Thread.Sleep(60); }
                catch (UnauthorizedAccessException) { System.Threading.Thread.Sleep(60); }
            }
            if (ok) Log("WriteCmd ok -> " + text);
            else Log("WriteCmd 放弃（文件一直被占用）：" + text);
        }
        catch (Exception ex) { Log("WriteCmd EXC: " + ex.Message); }
    }

    /// <summary>把状态文件推给页面（页面 stateRead() 用）。
    /// 🔴 2026-10-24：主人要的是「看见她在干嘛」。原来 2 秒推一次 + activity 被 keeper
    /// 覆盖 ⇒ 她说的话根本到不了页面。现在两个补丁：
    ///   ① 页面可以调 window.__petSay() 主动要最新一句（立刻回，不等 2 秒拍）
    ///   ② 主循环 500ms 看一次状态文件里 activity 变没变，变了立刻单独推</summary>
    /// <remarks>
    /// 🔴🔴 2026-10-25 重大修复（主人：「日记点击打不开」「对话功能你还是没加上去」）：
    ///    原来这里注入的是
    ///        window.chrome.webview.postMessage('state:' + json);
    ///    但 `window.chrome.webview.postMessage` 是**页面 → 宿主**方向的 API！
    ///    宿主自己执行它，等于把消息发给自己：WebMessageReceived 收到 'state:...'，
    ///    所有前缀分支都不匹配 ⇒ 被静默丢弃。**页面永远收不到状态。**
    ///    连锁后果（一个根因炸掉一串功能，之前一直没抓到真因）：
    ///      · 页面 pushedState = null ⇒ apiBase() = '' ⇒ fetch('/pet/diary') 打到
    ///        页面自己的 origin 上，404 ⇒ 右键「她的日记」只弹一句"日记本打不开"
    ///      · 聊天框也靠 apiBase() 找后端 ⇒ 对话根本没连上会话
    ///      · sprite_dir / persona 等凡是走 stateRead() 的都拿不到
    ///    ✅ 正确方向：宿主 → 页面 必须用 **ExecuteScriptAsync 直接调用页面里的函数**
    ///       （PushActivity 一直是对的，所以日志里 activity 正常 —— 这个对比就是破案线索）。
    /// </remarks>
    static void PushState()
    {
        try
        {
            if (Wv == null || Wv.CoreWebView2 == null) return;
            if (!File.Exists(StateFile)) return;
            string txt = File.ReadAllText(StateFile, Encoding.UTF8).TrimStart('\uFEFF');
            // 交给页面自己去解析：window.__petOnState(jsonText)。
            // 用 JsString 转义成 JS 字符串字面量，页面 JSON.parse —— 跟 PushActivity 同一套路。
            Wv.CoreWebView2.ExecuteScriptAsync("window.__petOnState && window.__petOnState(" + JsString(txt) + ");");
        }
        catch { }
    }

    /// <summary>只把 activity 推给页面（便宜、够快，500ms 一次也不心疼）。</summary>
    static void PushActivity()
    {
        try
        {
            if (Wv == null || Wv.CoreWebView2 == null) return;
            if (!File.Exists(StateFile)) return;
            string txt = File.ReadAllText(StateFile, Encoding.UTF8).TrimStart('\uFEFF');
            var ser = new JavaScriptSerializer();
            var j = ser.Deserialize<Dictionary<string, object>>(txt);
            if (j == null) return;
            string act = j.ContainsKey("activity") && j["activity"] is string ? (string)j["activity"] : "";
            double at = j.ContainsKey("activityAt") && j["activityAt"] != null ? Convert.ToDouble(j["activityAt"]) : 0;
            if (act == LastActivity && at == LastActivityAt) return;   // 没变就不推
            LastActivity = act; LastActivityAt = at;
            string js = "window.__petOnActivity && window.__petOnActivity(" + JsString(act) + "," + at.ToString("F0") + ");";
            Wv.CoreWebView2.ExecuteScriptAsync(js);
            if (act.Length > 0) Log("activity -> " + act);
        }
        catch { }
    }
    static string LastActivity = null;
    static double LastActivityAt = -1;

    static string JsString(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append("\"").ToString();
    }

    // ── 排障通道的安全阀 ──────────────────────────────────────────────────
    // 🔴🔴 2026-10-25 真实事故（这次是我自己造成的）：
    //    pet-test.txt 里留了一段测试 JS，内容是
    //      fetch('/pet/chat', {text:'接手验证：桌宠对话链路'})
    //    PollOnce 每 500ms 跑一次、读到文件就执行。原来的删除方式是
    //      File.ReadAllText → File.Delete
    //    两个**独立**步骤。只要 Delete 失败一次（antivirus 短暂锁、另一进程也在读、
    //    或者上一次执行的 JS 自己又写了回来），下一拍就会再读到同一个文件、再执行一遍。
    //    实测后果：**每 2 秒往会话里塞一条**，堆了 149 条同一句话在 next-turn，
    //    每轮上下文被刷满。
    //
    //    正确做法（本段）：**先原子重命名再读**。
    //      File.Move(src → src.running) 是原子操作，成功就意味着"我拿到了这个文件"，
    //      别人（包括下一拍的我）再也读不到它。失败就跳过这一拍，绝不清读。
    //    再加两道保险：① 一分钟最多执行 3 条排障脚本 ② 同一条内容连续出现直接丢弃。
    static string LastTestCmd = null;
    static int LastTestMinute = -1;
    static int TestRunsThisMinute = 0;
    static long LastClaimFailLogTicks = 0;
    const int TEST_MAX_PER_MINUTE = 3;

    static int TestMinuteOf(DateTime t) { return t.Hour * 60 + t.Minute; }

    static void PollOnce()
    {
        PushState();
        PushActivity();   // 她的"所思所想"：500ms 粒度紧跟，不等 2 秒那一拍
        // 🔴 排障通道（2026-10-25）：往家目录写 pet-test.txt，宿主读到就把内容当 JS 执行一次并删掉。
        //    为什么需要：这台机器上 SetCursorPos 模拟鼠标不可靠（读回坐标能跑到屏幕外），
        //    所以要验证「点菜单 → 动作 → 效果」只能从宿主侧驱动。只在本地，不外发任何东西。
        //    ⭐ 2026-10-25 追加：如果文件内容是 `act:<动作名>`，就当成"点了那一项右键菜单"，
        //      走和真人点菜单**完全相同**的 SendAct() 路径 —— 这样「她的日记」这种
        //      **宿主侧原生动作**（不开页面窗、宿主自己开日记本）也能被实测，
        //      而不是只能靠手点。理由：日记窗一直没人验证过它到底能不能开。
        //    ⚠️ 安全阀见上面 TEST_MAX_PER_MINUTE 那段注释（曾经每 2 秒重发、堆了 149 条）。
        try
        {
            string testFile = Path.Combine(Home, "pet-test.txt");
            if (File.Exists(testFile))
            {
                // ① 认领：用 **独占文件句柄**，不用 File.Move。
                //
                // 🔴🔴 2026-10-25 实测结论（这条比事故本身更值得记）：
                //    File.Move 在这个环境里**恒定失败**：
                //      claim failed (UnauthorizedAccessException hr=0x80070005) 对路径的访问被拒绝
                //    但同一个文件：
                //      · 宿主能看见（File.Exists=true，长度读得到）
                //      · PowerShell / Node 里 renameSync 都成功
                //      · ACL 跟宿主能正常读写的 pet-window-state.json 完全一样
                //      · 只有一个 PetHost 实例、没有 .running 残留
                //    ⇒ rename 需要的是**目录的删除/改名权限**，而宿主从 DSH 那儿继承的令牌
                //      在这一项上被拒（同一用户、同一会话，但令牌权限集不同）。
                //    结论：**不要用 rename 做认领**，它在这里根本走不通。
                //
                // ✅ 现在的做法：FileShare.None 独占打开 → 读内容 → 立刻删除。
                //    · 独占打开是**文件级**操作，只要对文件本身有读权限就行（宿主有）
                //    · FileShare.None 天然互斥：第二个打开者会直接 IOException，
                //      所以同一个文件不可能被两拍同时读（这正是当初 149 条重复的根因）
                //    · 删不掉也不重读：内容已经在手里，这一拍一定只执行一次
                string js = null;
                bool claimed = false;
                try
                {
                    using (var fs2 = new FileStream(testFile, FileMode.Open, FileAccess.Read, FileShare.None))
                    using (var sr2 = new StreamReader(fs2, Encoding.UTF8, true))
                    {
                        js = sr2.ReadToEnd().Trim();
                    }
                    claimed = true;   // 拿到了独占句柄并读完 ⇒ 这一条归我
                }
                catch (Exception exm)
                {
                    // 别人正拿着它 ⇒ 下一拍再试。这是正常竞争，不是错误。
                    if (DateTime.UtcNow.Ticks - LastClaimFailLogTicks > TimeSpan.TicksPerSecond * 30)
                    {
                        LastClaimFailLogTicks = DateTime.UtcNow.Ticks;
                        int hr = 0;
                        try { hr = System.Runtime.InteropServices.Marshal.GetHRForException(exm); } catch { }
                        Log("test channel: 独占打开失败（" + exm.GetType().Name + " hr=0x" + hr.ToString("X8") + "): " + exm.Message + " ⇒ 下一拍再试");
                    }
                }
                if (!claimed) return;
                // 删掉它：删不掉也无所谓（下次独占打开照样能读，且内容已消费）
                try { File.Delete(testFile); } catch { }

                if (js.Length > 0)
                {
                    // ② 限流：一分钟最多 3 条，防"某个脚本自己又写回来"变成死循环
                    int minute = TestMinuteOf(DateTime.Now);
                    if (minute != LastTestMinute) { LastTestMinute = minute; TestRunsThisMinute = 0; }
                    if (TestRunsThisMinute >= TEST_MAX_PER_MINUTE)
                    {
                        Log("test channel: 本分钟已执行 " + TestRunsThisMinute + " 条，超出上限 " + TEST_MAX_PER_MINUTE + " ⇒ 丢弃这条（防死循环）");
                        return;
                    }
                    // ③ 同一条内容连续出现 ⇒ 丢弃（真正的排障脚本不会重复灌同一句）
                    if (js == LastTestCmd)
                    {
                        Log("test channel: 与上一条完全相同 ⇒ 丢弃（防重放）");
                        return;
                    }
                    LastTestCmd = js;
                    TestRunsThisMinute++;

                    if (js.StartsWith("act:", StringComparison.Ordinal))
                    {
                        string act = js.Substring(4).Trim();
                        Log("test act: " + act);
                        try { SendAct(act); Log("test act dispatched: " + act); }
                        catch (Exception ea) { Log("test act EXC: " + ea.Message); }
                    }
                    else if (js.StartsWith("js:", StringComparison.Ordinal))
                    {
                        // 在**主窗口**里跑一段 JS 并回读结果（排障用）。
                        // 为什么单独加这个前缀：原来的默认分支也执行 JS，但它会把
                        // **整段脚本**（可能好几千字）塞进日志，而且和 `pixels:` 那些
                        // 自报通道混在一起。`js:` 是给自动探针用的显式口子：
                        // 只记前 100 字，结果单独一行 "js result:"，好抓。
                        string code = js.Substring("js:".Length);
                        if (Wv != null && Wv.CoreWebView2 != null)
                        {
                            Log("js: " + (code.Length > 100 ? code.Substring(0, 100) + "…" : code));
                            Wv.CoreWebView2.ExecuteScriptAsync(code).ContinueWith(tj =>
                            {
                                try { Log("js result: " + (tj.IsFaulted ? "FAULT " + tj.Exception.GetBaseException().Message : tj.Result)); } catch { }
                            });
                        }
                        else Log("js: 主窗口还没好（Wv=null）");
                    }
                    else if (js.StartsWith("reload:", StringComparison.Ordinal) || js == "reload")
                    {
                        // ⭐ 2026-10-25：写 `reload` 就让页面重新加载。
                        //   为什么需要：改页面（pet.js/pet.css/index.html）之后，
                        //   要验证就必须让 WebView2 重新取一遍 —— 否则内存里跑的还是旧脚本。
                        //   以前只能"杀掉宿主 → 等 keeper 拉起"，那一圈要 10 秒还容易撞
                        //   singleton 锁；现在一条指令 2 秒就换新。
                        Log("reload: 页面重载（测试通道）");
                        try
                        {
                            if (Wv != null && Wv.CoreWebView2 != null)
                            {
                                Wv.CoreWebView2.Reload();
                                Log("reload dispatched");
                            }
                            else Log("reload: 主窗口还没好（Wv=null）");
                        }
                        catch (Exception er) { Log("reload EXC: " + er.Message); }
                    }
                    else if (js.StartsWith("diaryjs:", StringComparison.Ordinal))
                    {
                        // 在**日记窗**里跑一段 JS 并回读结果（排障用）。
                        // 为什么需要：日记窗是宿主自己开的，主窗口的排障通道够不着它；
                        // "窗开了 + 页面加载了"还不等于"主人真的看见字了"，
                        // 得能把日记页的 DOM 读回来才算数。
                        string code = js.Substring("diaryjs:".Length);
                        if (DiaryWv != null && DiaryWv.CoreWebView2 != null)
                        {
                            Log("diary test js: " + (code.Length > 100 ? code.Substring(0, 100) + "…" : code));
                            DiaryWv.CoreWebView2.ExecuteScriptAsync(code).ContinueWith(td =>
                            {
                                try { Log("diary test result: " + (td.IsFaulted ? "FAULT " + td.Exception.GetBaseException().Message : td.Result)); } catch { }
                            });
                        }
                        else Log("diary test js: 日记窗没开（DiaryWv=null）");
                    }
                    else if (Wv != null && Wv.CoreWebView2 != null)
                    {
                        Log("test exec: " + (js.Length > 120 ? js.Substring(0, 120) + "…" : js));
                        Wv.CoreWebView2.ExecuteScriptAsync(js).ContinueWith(tt =>
                        {
                            try { Log("test result: " + (tt.IsFaulted ? "FAULT " + tt.Exception.GetBaseException().Message : tt.Result)); } catch { }
                        });
                    }
                }
            }
        }
        catch (Exception ext) { Log("test channel EXC: " + ext.Message); }
        try
        {
            DiagN++;
            if (DiagN % 5 == 0 && Wv != null && Wv.CoreWebView2 != null)
            {
                // 一次拿全「比例/坐标/可见性」证据：主人抓的问题都靠它判
                var dt = Wv.CoreWebView2.ExecuteScriptAsync(
                    "(function(){function R(id){var e=document.getElementById(id);if(!e)return null;" +
                    "var r=e.getBoundingClientRect();var s=getComputedStyle(e);" +
                    "return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),disp:s.display,op:s.opacity};}" +
                    "var cv=document.getElementById('gl');" +
                    "return JSON.stringify({vw:innerWidth,vh:innerHeight,cv:cv?(cv.width+'x'+cv.height):null," +
                    "bg:getComputedStyle(document.body).backgroundColor,gl:R('gl'),pet:R('pet'),tb:R('toolbar')," +
                    // ⭐ 气泡几何（主人 2026-10-25 抓的「文本框显示不完全」）：
                    //    clipped=true 就说明气泡超出了窗口上边 —— 一眼能看出有没有再被裁
                    "bubble:(function(){var e=document.getElementById('pet-bubble');if(!e)return null;" +
                    "var r=e.getBoundingClientRect();var s=getComputedStyle(e);" +
                    "return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)," +
                    "disp:s.display,clipped:(r.top<0),bottomEdge:Math.round(r.bottom)};})()," +
                    "last:window.__lastMouse||null,clickthrough:" + (ClickThrough ? "true" : "false") + "});})()");
                dt.ContinueWith(t2 => { Log("diag: " + (t2.IsFaulted ? "FAULT" : t2.Result)); });
                // 顺带让页面刷新一次命中矩形（页面把"她"的 alpha 包围盒 + UI 矩形报回来）
                Wv.CoreWebView2.ExecuteScriptAsync("window.__petReportRects && window.__petReportRects();");
                // 🔴 2026-10-25 加：读 canvas **真实像素**，确认引擎真的画了东西。
                //    ⚠️ 不能在任意时刻 readPixels —— WebGL 默认 preserveDrawingBuffer=false，
                //    帧提交后缓冲就清空，事后读必然全是 0（我因此误判过一次"她没画出来"）。
                //    页面里的 window.__petPixels() 排进 rAF，紧跟 render() 之后读，才是真的。
                Wv.CoreWebView2.ExecuteScriptAsync(
                    "(window.__petPixels?window.__petPixels().then(function(v){window.chrome.webview.postMessage('pixels:'+JSON.stringify(v))}):0)")
                    .ContinueWith(t4 => { try { if (t4.IsFaulted) Log("pixels 脚本失败"); } catch { } });
            }
        }
        catch { }
        // 状态文件过期不再自杀——宿主/面板重启期间状态会断供
        if (!File.Exists(StateFile)) return;
        var fi = new FileInfo(StateFile);
        if ((DateTime.UtcNow - fi.LastWriteTimeUtc).TotalSeconds > 600)
        {
            if (!StaleLogged) { StaleLogged = true; Log("state stale (>10min) -> 留守，不退出"); }
            return;
        }
        StaleLogged = false;
        string txt = File.ReadAllText(StateFile, Encoding.UTF8).TrimStart('\uFEFF');
        Dictionary<string, object> j;
        try { j = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(txt); }
        catch { return; }
        if (j == null) return;
        bool on = true;
        if (j.ContainsKey("on") && j["on"] is bool) on = (bool)j["on"];
        if (!on) { Log("state on=false -> exit"); Win.Close(); return; }
        if (j.ContainsKey("sprite_dir") && j["sprite_dir"] is string)
        {
            string sd = (string)j["sprite_dir"];
            if (SpriteDir == null) { SpriteDir = sd; Log("sprite_dir=" + sd); }
        }
    }
}
