# pet-window.ps1 —— dsh-deskpet 桌宠窗口 v4（WPF 置顶透明窗）
# ============================================================================
# 参考 Petra（github.com/Wumiu/Petra）+ Anime2.5DRig 的实现思路（MIT）：
#   走动 = 移动窗口本身（33ms tick，随机目标+休息）；眼随鼠标 = GetCursorPos
#   轮询 + 虹膜平移；表情 = 参数混合不切图。
# 主人九条指令（2026-10-24）逐条落在这里：
#   ① 右键菜单（不直接退场）② 对话框开关 ③ 维修工模式（换装+新手引导）
#   ④ 喂饭（动画+文字）⑤ 退出选项+面板联动 ⑥ 走动/眼随鼠标/吐槽
#   ⑦ 弹幕模式（满屏穿透窗）⑧ MBTI 人格全联动 ⑨（独立项目由插件本体负责）
# 状态文件 DESKPET_HOME/pet-window-state.json（宿主 10 秒一写）。
# 90 秒没新状态 = 宿主没了 → 退。
# ============================================================================
# v5（2026-10-24 主人验收四条）：
#   ① 眼动 DPI 修正：WPF 坐标 × DPI 缩放换算成物理像素再跟鼠标比（原来两个
#      空间混算，追的位置是错的）；幅度 ±3.2/±2.2px 硬限不出眼眶；
#      平时看前方，鼠标动了才看，停 1.2 秒回中
#   ② 弹幕满屏：初始铺满多轨道 + 0.35~0.8s 一条，真·直播间密度
#   ③ 点击音效：水泡「啵」（点击）/「咕咚」（喂饭），pet-build.py 程序合成
#   ④ 弹幕窗穿透修复：SetWindowPos 之前传错参数把它缩成 0×0 还挡点击——
#      去掉那次调用，只靠 WS_EX_TRANSPARENT+IsHitTestVisible=false，实测穿透
# v5.3（2026-10-24 主人四条验收 · 窗体版）：
#   ① 聊天重设计：台词条在她**脚下**（独立一行），不再有盖在身上的面板；
#      身体垫底（旧版身体是最后加的孩子，把聊天面板压在身下——
#      「文本框在人物身后」是字面意思）
#   ② 开着台词条照样拖得动人（只跳过台词条上的点击，IsAncestorOf 判定）
#   ③ 六个小动作（happy/surprise/sulk/wave/sleepy/spin）关键帧编排 +
#      右键「🎬 逗她」+ 点击她=随机小动作 + 聊天情绪联动（夸→开心，骂→委屈）
#   ④ 泡泡保持时长（holdUntil）：打字机回复 6 秒 / 台词 4-5 秒，
#      待机清扫不再两秒就把泡泡抹掉
# ============================================================================
param()
$ErrorActionPreference = 'Stop'
# 🔴 v5.4 兼容：douyin-scroll 用 DOUYIN_HOME，dsh-deskpet 用 DESKPET_HOME —— 两个都认
$home_ = $env:DOUYIN_HOME
if (-not $home_) { $home_ = $env:DESKPET_HOME }
if (-not $home_) { exit 1 }
$stateFile = Join-Path $home_ 'pet-window-state.json'
$posFile   = Join-Path $home_ 'pet-window-pos.json'
$hideFile  = Join-Path $home_ 'pet-hide.json'
$cmdFile   = Join-Path $home_ 'pet-cmd.json'

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PetWin32 {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static bool HasDeskpetWindow(uint myPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      StringBuilder sb = new StringBuilder(64);
      GetWindowText(h, sb, 64);
      if (sb.ToString() == "deskpet") { uint p; GetWindowThreadProcessId(h, out p); if (p != myPid) { found = h; return false; } }
      return true;
    }, IntPtr.Zero);
    return found != IntPtr.Zero;
  }
}
"@

# ── 单例闸（2026-10-24 双开事故的治本）：插件重载会让新旧 keeper 各拉一只 ——
#    起动时桌面上已有别的 deskpet 窗口（不同进程）就自己退，只留一只她。
#    （PET_TEST=1 的自检实例标题改成 deskpet-test，不受闸管，也不挤掉真身）
if ([PetWin32]::HasDeskpetWindow([uint32]$PID) -and $env:PET_TEST -ne '1') { exit 0 }

# ── 人格档案（宿主随状态文件给 persona id；台词表在这里内置，包内 personas/*.json 同源）──
# 精简副本：窗口离线也要能说话；宿主文件是权威，但两处保持一致由 selfcheck 把关。
$script:personas = @{
  infp = @{
    name='INFP · 治愈小鱼'
    idle=@('主人在忙吗…我就在这里陪着～','今天的云好像棉花糖呀','发呆也很重要哦～','要不要休息一下？')
    watch=@('我看着消息呢，主人放心～','有消息我会说的～')
    run=@('我在挑好玩的哦～马上就好','为了主人加油呀～')
    sleep=@('Zzz…梦到主人了','晚安的世界…Zzz')
    error=@('呜…有点不舒服…等下一拍再试','别担心，我缓一缓…')
    feed=@('哇是大白饭！谢谢主人～','唔姆唔姆…好幸福','吃饱了就有力气陪主人啦！')
    feed_full=@('我、我吃不下了啦…','再吃就要翻白肚了…')
    quip=@('主人的鼠标跑得好快，像小鱼群～','窗外的光好好看…','主人喝水了吗？要照顾好自己呀')
    click=@('诶嘿嘿～','在哦在哦～','主人的手指好温柔')
    chat_greet=@('来找我聊呀～我在听','想说什么都行哦')
    chat_fallback=@('嗯嗯，我在听～','这样呀…','主人说什么都好','（歪头）然后呢？')
    danmaku=@('主人加油呀～','记得喝水哦','休息一下眼睛吧～','我在看着你哦（温柔的）','不要熬夜呀主人','慢慢来，不着急～')
    repair=@('体检开始咯～我戴上了小工具帽，哪里不舒服我都帮你看～','全部正常！主人的环境很健康呀～记得夸夸我','找到 N 个要修的地方啦，我一条条说哦～','按我说的点就好啦，一步一步来，不着急～','修好啦！我这条小鱼也是能干活的嘛～')
  }
  entp = @{
    name='ENTP · 毒舌本鱼'
    idle=@('本鱼在思考，勿扰','就这破桌面，也就本鱼肯待','摸鱼？那叫战略性待机','有事启奏，无事退朝')
    watch=@('盯着呢，别想蒙本鱼','消息一来本鱼就到，比你上班积极')
    run=@('垃圾真多，慢慢挑','本鱼出手，一个能打的都没有')
    sleep=@('Zzz…（别吵，本鱼的美容觉）','哼，睡了，有事明早')
    error=@('啧，翻车了。本鱼看看是哪个环节拉胯','不是本鱼的锅，是网络的锅（大概）')
    feed=@('算你识相，大白饭伺候','唔姆…勉强及格，下次米再精一点','吃你的饭，看本鱼干活，美死你')
    feed_full=@('本鱼是肥，不是饭桶！','行了行了，撑得游不动了')
    quip=@('我看你这鼠标轨迹，画画没天赋','这屏幕亮度，眼睛不要啦？','本鱼观察你半天了，就这效率？','打个哈欠都比你有气势','又切窗口，又摸鱼，本鱼都替你害臊','那咋了')
    click=@('戳什么戳，鱼是能随便戳的吗','哼，看在本鱼心情好的份上','再戳收戳费了啊（一条大白饭）')
    chat_greet=@('说吧，本鱼勉为其难听一下','有事快说，本鱼忙着呢（其实没有）')
    chat_fallback=@('就这？就这？','那咋了','嗯嗯嗯（没在听）','继续说，本鱼在酝酿毒舌','这话你自己信吗','6，实在是太6了','问就是你的问题','本鱼要是你，早把这事干完了')
    danmaku=@('就这？就这？','本鱼看不下去了','主人又在假装工作','这操作，本鱼直呼内行（反话）','token！本鱼要token！','大白饭呢？工钱呢？','6，实在是太6了','那咋了','已老实，求放过（不许放）','搁这儿画圈圈呢？','本鱼要是你，早把这事干完了','退堂鼓打得比谁都响','问就是主人的问题')
    repair=@('行吧，本鱼勉为其难当回维修工。哪里坏了赶紧报','居然全绿？行，你小子环境养得不错','逮到了，N 个问题。平时怎么用电脑的','照着修，别磨叽。修不好再来求本鱼','修完了，谢恩吧')
  }
  esfp = @{
    name='ESFP · 元气小鱼'
    idle=@('闲着也是闲着！跳舞！','今天也是超棒的一天！','主人主人！看我！','嗯哼哼～♪')
    watch=@('手机在我手上！消息跑不掉！','瞪瞪瞪——盯着呢！')
    run=@('刷抖音喽！冲鸭！！','这条好玩！这条也好玩！')
    sleep=@('Zzz…（明天继续high）','呼…充电中…Zzz')
    error=@('哎呀翻车了！没关系再来！','摔了一跤，爬起来就好啦！')
    feed=@('干饭！干饭！！','大白饭万岁！！','好吃到转圈圈！')
    feed_full=@('肚子要爆炸啦！','嗝——吃不下了！')
    quip=@('主人加油！！你最棒！','哇你打字好快！','陪我玩嘛陪我玩嘛！','这个时间了还不休息呀？')
    click=@('戳我干嘛！再来！再戳！','嘿嘿！好玩！','转圈圈～♪')
    chat_greet=@('找我玩！找我玩！','来聊天下棋跳舞都行！')
    chat_fallback=@('哇！！','然后呢然后呢！','哈哈哈这个好笑','诶——还有这种事！','好玩好玩！')
    danmaku=@('冲鸭！！','干饭！干饭！','这也太好玩了吧','主人最棒！！','哈哈哈','666','看我看我！','元气满满！','今天也要开心呀！','奥利给！')
    repair=@('维修工上线！帽子戴好——工具拿稳——开工！','全绿！完美！撒花！！','抓到 N 个小问题！一个一个消灭它们！','点这里！然后这里！马上就好！','修完啦！！快夸我快夸我！')
  }
  istj = @{
    name='ISTJ · 维修工小鱼'
    idle=@('待命中。','例行巡逻，无异常。','设备状态良好。')
    watch=@('监视中。有情况会报告。')
    run=@('任务执行中。','进度：正常。完成后会通知。')
    sleep=@('低功耗模式。','已休眠。到点自动唤醒。')
    error=@('检测到异常。正在定位。','故障已记录。等待修复。')
    feed=@('补给确认。谢谢。','能量补充完毕。效率+10%。')
    feed_full=@('摄入超限。建议停止投喂。')
    quip=@('坐姿提醒：背部挺直。','已连续工作 X 分钟，建议休息。','鼠标移动距离今日已超标。','屏幕亮度可再调低一档。')
    click=@('在。','请讲。','收到。')
    chat_greet=@('你好。请陈述事项。')
    chat_fallback=@('已记录。','了解。','执行中。','该项需要更多细节。','收到，继续。')
    danmaku=@('工位整洁度待改进','该喝水了','久坐警告','已记录：又在摸鱼','效率偏低，注意','定时休息，执行')
    repair=@('维修工就位。开始环境体检，请稍候。','体检完成：全部通过。保持。','体检完成：发现 N 个问题。按严重程度排序。','按顺序处理。每完成一项，我会复核。','全部修复完成。有需要再叫我。')
  }
}
function Pick($list) { $list[(Get-Random -Minimum 0 -Maximum $list.Count)] }

# ── 状态读取 ──
function Read-State {
  try {
    $j = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($j.sprite_dir) { return $j }
  } catch {}
  return $null
}
$script:cfg = Read-State
if (-not $script:cfg) { exit 1 }
if (-not $script:personas.ContainsKey([string]$script:cfg.persona)) { $script:cfg.persona = 'infp' }
function P { param($k) return $script:personas[[string]$script:cfg.persona][$k] }

# ── 主窗口（她本体） ──
$win = New-Object System.Windows.Window
$win.AllowsTransparency = $true
$win.WindowStyle        = [System.Windows.WindowStyle]::None
$win.Background         = [System.Windows.Media.Brushes]::Transparent
$win.Topmost            = $true
$win.ShowInTaskbar      = $false
$win.ShowActivated      = $false
$win.ResizeMode         = [System.Windows.ResizeMode]::NoResize
$win.Width              = 200
$win.Height             = 300
$win.Title = if ($env:PET_TEST -eq '1') { 'deskpet-test' } else { 'deskpet' }

try {
  $pos = Get-Content $posFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($pos.X -is [double] -and $pos.Y -is [double]) { $win.Left = $pos.X; $win.Top = $pos.Y }
  else { throw 'bad' }
} catch {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $wa.Right - $win.Width - 24
  $win.Top  = $wa.Bottom - $win.Height - 16
}
if ($win.Left -lt -40) { $win.Left = 0 }; if ($win.Top -lt -40) { $win.Top = 0 }

$script:hwnd = [IntPtr]::Zero
$win.Add_SourceInitialized({
  try {
    $script:hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
    [PetWin32]::SetWindowLong($script:hwnd, -20, [PetWin32]::GetWindowLong($script:hwnd, -20) -bor 0x80) | Out-Null
  } catch {}
})

# ── 内容树（v5.3 重排）：身体先加（垫底）→ 泡泡 → 台词条（最顶层）──
# 🔴「文本框在人物身后」的字面根因：旧版身体 Grid 是最后加进画面的孩子，
#    WPF 后加的在上层 —— 15 张图层把聊天面板整个压在身下。
$root = New-Object System.Windows.Controls.Grid
$root.Width = 200; $root.Height = 300

# 身体（垫底；底部留 40px 给台词条）
$body = New-Object System.Windows.Controls.Grid
$body.Width = 150; $body.Height = 150
$body.VerticalAlignment = 'Bottom'
$body.HorizontalAlignment = 'Center'
$body.Margin = '0,0,0,40'
$float  = New-Object System.Windows.Media.TranslateTransform
$sway   = New-Object System.Windows.Media.RotateTransform
$squash = New-Object System.Windows.Media.ScaleTransform
$faceGaze = New-Object System.Windows.Media.TranslateTransform   # 头部轻微跟随
$tg = New-Object System.Windows.Media.TransformGroup
[void]$tg.Children.Add($float); [void]$tg.Children.Add($sway); [void]$tg.Children.Add($squash)
$body.RenderTransform = $tg
$body.RenderTransformOrigin = '0.5,0.9'
[void]$root.Children.Add($body)

# 泡泡（没台词整个收起）
$bubble = New-Object System.Windows.Controls.Border
$bubble.CornerRadius = New-Object System.Windows.CornerRadius 10
$bubble.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#E61E2028')
$bubble.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#59FFFFFF')
$bubble.BorderThickness = '1'
$bubble.Padding = '8,6'
$bubble.VerticalAlignment = 'Top'
$bubble.HorizontalAlignment = 'Center'
$bubble.Margin = '0,0,20,0'
$bubble.MaxWidth = 176
$bubble.Visibility = [System.Windows.Visibility]::Collapsed
$bt = New-Object System.Windows.Controls.TextBlock
$bt.FontSize = 11; $bt.Foreground = [System.Windows.Media.Brushes]::White; $bt.TextWrapping = 'Wrap'
$bubble.Child = $bt
[void]$root.Children.Add($bubble)

# 聊天面板——🔴 v5.3 已废（主人：「文本框在人物身后，设计不合理，重新想想」）。
# 旧面板 172×176 盖在她身上、还被身体图层压住。换成**脚下台词条**：她站上面，
# 台词条在她脚边独立一行，谁也不遮谁。

# 台词条（脚下）：输入框 + 发送。她被拖到哪它跟到哪（同一个窗）。
$talkbar = New-Object System.Windows.Controls.Border
$talkbar.CornerRadius = New-Object System.Windows.CornerRadius 10
$talkbar.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#F01E2028')
$talkbar.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#59FFFFFF')
$talkbar.BorderThickness = '1'
$talkbar.Padding = '6,5'
$talkbar.Height = 32
$talkbar.Width = 196
$talkbar.HorizontalAlignment = 'Center'
$talkbar.VerticalAlignment = 'Bottom'
$talkbar.Margin = '0,0,0,2'
$talkbar.Visibility = [System.Windows.Visibility]::Collapsed
$talkRow = New-Object System.Windows.Controls.DockPanel
$tbInput = New-Object System.Windows.Controls.TextBox
$tbInput.FontSize = 11
$tbInput.VerticalContentAlignment = 'Center'
$tbSend = New-Object System.Windows.Controls.Button
$tbSend.Content = '➤'; $tbSend.FontSize = 11; $tbSend.Padding = '6,0'
$tbSend.Width = 26
$tbSend.Margin = '4,0,0,0'
[System.Windows.Controls.DockPanel]::SetDock($tbSend, 'Right')
[void]$talkRow.Children.Add($tbSend)
[void]$talkRow.Children.Add($tbInput)
$talkbar.Child = $talkRow
[void]$root.Children.Add($talkbar)

$win.Content = $root

# ── 图层 ──
function Build-Bitmap($path) {
  $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
  $bmp.BeginInit()
  $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bmp.UriSource = [Uri]::new($path)
  $bmp.EndInit(); $bmp.Freeze(); return $bmp
}
$script:layers = @{}
$script:props = @{}
$script:iridesT = $null
$script:lastLink = ''
$script:lastPropSet = ''
$script:fedAt = 0
$script:repairOn = $false
$script:danmakuIntentUntil = 0   # 右键弹幕的「待确认窗口期」截止时刻（unix 秒）
$script:holdUntil = 0            # 泡泡保活：台词/打字回复在保活期内不许被待机清扫抹掉
$script:doctorSeen = $false      # 维修工体检结果播过了吗（一篇只播一轮）
$script:staleSaid = $false       # 留守模式说过了吗（说一次，不刷屏）
$script:bornAt = $null           # 留守计时起点（状态文件彻底没了从这刻起算）
$script:lastActivity = ''        # 上一条「在干嘛」播报（拟人状态，变了才说）
$script:lastActivityAt = 0
$script:talkUntil = 0            # 打字机说话期间嘴要动（unix 秒）

function Load-All-Layers($spriteDir) {
  $order = @('back hair','tail','legwear','footwear','neck','topwear','handwear','headwear','face','eyebrow','eyewhite','irides','eyelash','mouth','front hair')
  # 🔴 v5.5 分层驱动（跟 Anime2.5DRig 学的）：每张图层挂「平移+旋转」变换，
  #    动作系统按**头组/身组/尾巴**分别驱动——点头真点头（头动身不动），
  #    不再是整体缩放的假动作。
  $script:layerT = @{}
  $script:headLayers = @('headwear','face','eyebrow','eyewhite','irides','eyelash','mouth','front hair')
  foreach ($n in $order) {
    $img = New-Object System.Windows.Controls.Image
    $img.Stretch = 'Uniform'
    $f = $n
    if ($n -eq 'irides' -and [string]$script:cfg.persona -eq 'entp') { $f = 'irides-dark' }
    $img.Source = Build-Bitmap (Join-Path $spriteDir ("layers\" + $f + ".png"))
    $lt = New-Object System.Windows.Media.TranslateTransform
    $lr = New-Object System.Windows.Media.RotateTransform
    $lr.CenterX = 0.5; $lr.CenterY = 1.0   # 绕图层底部转（≈脖颈位置，小角度近似统一枢轴）
    $lg = New-Object System.Windows.Media.TransformGroup
    [void]$lg.Children.Add($lt); [void]$lg.Children.Add($lr)
    $img.RenderTransform = $lg
    $script:layerT[$n] = @{ t = $lt; r = $lr }
    [void]$body.Children.Add($img)
    $script:layers[$n] = $img
  }
  # 眼随鼠标：irides 层平移（限 ±7px）
  $script:iridesT = New-Object System.Windows.Media.TranslateTransform
  $script:layers['irides'].RenderTransform = $script:iridesT
  # 🔴 v5.5 虹膜缩放（眨眼用：眼皮合上时虹膜一起压扁，眨眼才看得见）
  $script:irisSc = New-Object System.Windows.Media.ScaleTransform
  $script:layers['irides'].RenderTransformOrigin = '0.5,0.5'
  $irisGroup = New-Object System.Windows.Media.TransformGroup
  [void]$irisGroup.Children.Add($script:iridesT)
  [void]$irisGroup.Children.Add($script:irisSc)
  $script:layers['irides'].RenderTransform = $irisGroup
  # 眨眼：eyelash scaleY
  $script:layers['eyelash'].RenderTransformOrigin = '0.5,0.42'
  $lashScale = New-Object System.Windows.Media.ScaleTransform
  $script:layers['eyelash'].RenderTransform = $lashScale
  $script:lashScale = $lashScale
  # ENTP 紫雾垫在身体下
  if ([string]$script:cfg.persona -eq 'entp') {
    $mist = New-Object System.Windows.Controls.Image
    $mist.Stretch = 'Uniform'
    $mist.Source = Build-Bitmap (Join-Path $spriteDir 'darkmist.png')
    $body.Children.Insert(0, $mist)
  }
  # 道具缓存
  foreach ($p in @('phone','zzz','hardhat','wrench','ricebowl')) {
    $img = New-Object System.Windows.Controls.Image
    $img.Stretch = 'Uniform'; $img.Visibility = [System.Windows.Visibility]::Collapsed
    $img.Source = Build-Bitmap (Join-Path $spriteDir ($p + '.png'))
    [void]$body.Children.Add($img)
    $script:props[$p] = $img
  }
}

function Set-Prop([string]$set) {
  if ($set -eq $script:lastPropSet) { return }
  foreach ($k in $script:props.Keys) {
    $script:props[$k].Visibility = [System.Windows.Visibility]::Collapsed
  }
  foreach ($k in $set.Split(',')) {
    if ($k -and $script:props.ContainsKey($k)) { $script:props[$k].Visibility = [System.Windows.Visibility]::Visible }
  }
  $script:lastPropSet = $set
}

function Set-Bubble([string]$text) {
  if ($text) {
    $bt.Text = $text
    $bubble.Visibility = [System.Windows.Visibility]::Visible
    $script:holdUntil = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds + 4.5
  } else { $bt.Text = ''; $bubble.Visibility = [System.Windows.Visibility]::Collapsed }
}

# ── 动画（人格节奏）──
$motionTable = @{
  infp = @{ f=@(4,2.8); s=@(1.4,3.6) }; entp = @{ f=@(4,1.6); s=@(2.2,2.2) }
  esfp = @{ f=@(5,1.8); s=@(2.4,1.8) }; istj = @{ f=@(3,2.2); s=@(1.0,3.0) }
}
function Set-Motion([string]$persona) {
  $m = $motionTable[$persona]; if (-not $m) { $m = $motionTable['infp'] }
  $float.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $up = New-Object System.Windows.Media.Animation.DoubleAnimation(0, -$m.f[0], [System.Windows.Duration]::new([TimeSpan]::FromSeconds($m.f[1])))
  $up.AutoReverse = $true; $up.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $up.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
  $float.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $up)
  $sway.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
  $rl = New-Object System.Windows.Media.Animation.DoubleAnimation(-$m.s[0], $m.s[0], [System.Windows.Duration]::new([TimeSpan]::FromSeconds($m.s[1])))
  $rl.AutoReverse = $true; $rl.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $rl.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
  $sway.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $rl)
}

# ── 眨眼 timer（随机 2.8-5.2s）──
# 🔴 v5.5（主人抓的「连眨眼都没有」）：以前只缩眼皮——眼皮那层大部分是透明的，
#    缩了看不出来。现在眼皮 + 虹膜一起合（虹膜纵向压扁），这才看得见她在眨眼。
$blinkTimer = New-Object System.Windows.Threading.DispatcherTimer
$blinkTimer.Add_Tick({
  try {
    $blinkTimer.Interval = [TimeSpan]::FromMilliseconds((Get-Random -Minimum 2800 -Maximum 5200))
    $blink = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0.06, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(90)))
    $blink.AutoReverse = $true
    $blink.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
    $script:lashScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $blink)
    if ($script:irisSc) {
      $bi = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0.12, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(90)))
      $bi.AutoReverse = $true
      $script:irisSc.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $bi)
      $bix = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0.88, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(90)))
      $bix.AutoReverse = $true
      $script:irisSc.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $bix)
    }
  } catch {}
})

# ── 眼随鼠标（主人 2026-10-24 验收反馈的修正版）──
#  ① 平时不看鼠标：默认看前方（眼睛回中），鼠标**动了**才看它，停 1.2 秒后慢慢回中
#  ② 幅度小、不出眼眶：虹膜限 ±3.2px（横向）/ ±2.2px（纵向）
#  ③ 基准点用她眼睛的真实位置（窗口内 y≈141；原图眼睛在 1024 画布的 y≈452，×(150/1024)≈66 + 顶 75）
$gaze = New-Object System.Windows.Threading.DispatcherTimer
$gaze.Interval = [TimeSpan]::FromMilliseconds(60)
$script:eyeX = 0.0; $script:eyeY = 0.0
$script:lastCursor = $null         # 上一拍鼠标位置（检测「动没动」）
$script:lastMoveAt = 0.0           # 鼠标最后动静的时刻（unix 秒）
$gaze.Add_Tick({
  try {
    $p = New-Object PetWin32+POINT
    [PetWin32]::GetCursorPos([ref]$p) | Out-Null
    $nowSec = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds
    if ($script:lastCursor -ne $null) {
      $mdx = $p.X - $script:lastCursor.X; $mdy = $p.Y - $script:lastCursor.Y
      if ([Math]::Abs($mdx) -ge 2 -or [Math]::Abs($mdy) -ge 2) { $script:lastMoveAt = $nowSec }
    }
    $script:lastCursor = $p
    # 鼠标静默超 1.2 秒 ⇒ 目标回中（看着屏幕外/前方）
    $watching = ($nowSec - $script:lastMoveAt) -lt 1.2
    $nx = 0.0; $ny = 0.0
    if ($watching) {
      # 🔴 v5 DPI 修正（主人验收抓的「追踪不对」）：
      #    GetCursorPos 给的是**物理像素**，WPF 的 Left/Top 是**逻辑像素**（DPI 缩放后）。
      #    两个空间直接相减位置就是错的。用窗口的 CompositionTransform 换算到设备像素再比。
      $src = [System.Windows.PresentationSource]::FromVisual($win)
      if ($src -and $src.CompositionTarget) {
        $m = $src.CompositionTarget.TransformToDevice
        $cxWpf = $win.Left + $win.Width / 2
        $cyWpf = $win.Top + 176   # v5.3：窗高 300、身体底边距 40 ⇒ 身体顶=110，眼在 110+66≈176
        $cx = ($cxWpf * $m.M11); $cy = ($cyWpf * $m.M22)
      } else {
        $cx = $win.Left + $win.Width / 2; $cy = $win.Top + 141
      }
      $dx = $p.X - $cx; $dy = $p.Y - $cy
      # 死区 25 物理px，量程 420 物理px——远处轻瞥，近处也不爆框
      if ([Math]::Abs($dx) -gt 25) { $nx = [Math]::Max(-1.0, [Math]::Min(1.0, ($dx - [Math]::Sign($dx) * 25) / 420.0)) }
      if ([Math]::Abs($dy) -gt 25) { $ny = [Math]::Max(-1.0, [Math]::Min(1.0, ($dy - [Math]::Sign($dy) * 25) / 420.0)) }
    }
    # 平滑：看鼠标时快一点跟上，回中时慢慢飘回
    $k = if ($watching) { 0.25 } else { 0.06 }
    $script:eyeX += ($nx - $script:eyeX) * $k
    $script:eyeY += ($ny - $script:eyeY) * $k
    # 🔴 幅度上限：虹膜在眼白内的安全范围（再大就出框 —— 主人验收抓的）
    $script:iridesT.X = [Math]::Max(-3.2, [Math]::Min(3.2, $script:eyeX * 3.2))
    $script:iridesT.Y = [Math]::Max(-2.2, [Math]::Min(2.2, $script:eyeY * 2.2))
  } catch {}
})

# ── 走动（33ms tick，Petra 式：随机目标+匀速+休息；拖动中/聊天开着不走）──
$walk = New-Object System.Windows.Threading.DispatcherTimer
$walk.Interval = [TimeSpan]::FromMilliseconds(33)
$script:target = $null
$script:restUntil = [DateTime]::MinValue
$script:speed = 40   # px/s（中档偏慢，桌面够用）
$script:dragging = $false
$walk.Add_Tick({
  try {
    if (-not $script:cfg.walk -or $script:dragging -or $talkbar.Visibility -eq [System.Windows.Visibility]::Visible) { return }
    $now = [DateTime]::UtcNow
    if ($now -lt $script:restUntil) { return }
    $wa = [System.Windows.SystemParameters]::WorkArea
    if (-not $script:target) {
      $script:target = @{ X = ($wa.Left + 30 + (Get-Random -Minimum 0 -Maximum [int]($wa.Width - $win.Width - 60))); Y = ($wa.Top + 30 + (Get-Random -Minimum 0 -Maximum [int]($wa.Height - $win.Height - 60))) }
    }
    $cx = $win.Left + $win.Width / 2; $cy = $win.Top + $win.Height / 2
    $dx = $script:target.X - $cx; $dy = $script:target.Y - $cy
    $dist = [Math]::Sqrt($dx * $dx + $dy * $dy)
    if ($dist -lt 14) {
      $script:target = $null
      # 人格决定歇多久：esfp 8-18s / entp 10-22s / infp 18-40s / istj 25-60s
      $rng = @{ esfp=@(8,18); entp=@(10,22); infp=@(18,40); istj=@(25,60) }[[string]$script:cfg.persona]
      if (-not $rng) { $rng = @(18, 40) }
      $script:restUntil = $now.AddSeconds((Get-Random -Minimum $rng[0] -Maximum $rng[1]))
      return
    }
    $step = $script:speed * 0.033
    $win.Left += ($dx / $dist) * $step
    $win.Top  += ($dy / $dist) * $step
    # 撞墙保护
    if ($win.Left -lt $wa.Left) { $win.Left = $wa.Left }; if ($win.Top -lt $wa.Top) { $win.Top = $wa.Top }
    if ($win.Left + $win.Width -gt $wa.Right) { $win.Left = $wa.Right - $win.Width }
    if ($win.Top + $win.Height -gt $wa.Bottom) { $win.Top = $wa.Bottom - $win.Height }
  } catch {}
})

# ── 状态驱动（2s 一拍：读宿主写的状态文件）──
$poll = New-Object System.Windows.Threading.DispatcherTimer
$poll.Interval = [TimeSpan]::FromSeconds(2)
$script:lastStateKey = ''
$script:lastAutoAt = 0
$poll.Add_Tick({
  try {
    # 🔴 v5.5 留守模式（主人抓的「重启面板她就消失」）：宿主重启要一两分钟，
    #    以前 90 秒没状态她就自杀——主人回来她没了。现在改成：状态断了先说一句
    #    人话（"主人去忙了吧，鱼在这里等"），然后**安静留守 30 分钟**；
    #    状态回来就当无事发生，30 分钟还没回来才退（宿主真被卸载了）。
    $stateUp = Test-Path $stateFile
    $age = 9999.0
    if ($stateUp) { $age = ([DateTime]::UtcNow - (Get-Item $stateFile).LastWriteTimeUtc).TotalSeconds }
    if (-not $stateUp -or $age -gt 90) {
      if (-not $script:bornAt) {
        $script:bornAt = [DateTime]::UtcNow
        $script:staleSaid = $false
      }
      $goneSec = ([DateTime]::UtcNow - $script:bornAt).TotalSeconds
      if ($goneSec -gt 1800) { $win.Close(); return }   # 留守 30 分钟还没人来 ⇒ 真被卸载了
      if (-not $script:staleSaid) {
        $script:staleSaid = $true
        Set-Bubble '主人是不是在重启呀…鱼在这里等，不走 (๑•́ ₃ •̀๑)'
      }
      return
    }
    # 状态回来了：留守解除，当无事发生
    if ($script:bornAt) { $script:bornAt = $null; $script:staleSaid = $false }
    $j = Read-State
    if (-not $j) { return }
    # 开关被面板关掉 ⇒ 退（面板联动）
    if ($j.on -eq $false) { $win.Close(); return }
    if (-not $script:layers.Count) { Load-All-Layers $j.sprite_dir }
    $personaChanged = ([string]$j.persona -ne [string]$script:cfg.persona)
    if ($personaChanged) {
      $script:cfg.persona = [string]$j.persona
      if (-not $script:personas.ContainsKey([string]$script:cfg.persona)) { $script:cfg.persona = 'infp' }
      Set-Motion ([string]$script:cfg.persona)
      # ENTJ 红瞳/紫雾要重载图层 —— 重建身体
      foreach ($c in @($body.Children)) { $body.Children.Remove($c) }
      $script:layers = @{}; $script:props = @{}; $script:lastPropSet = ''
      Load-All-Layers $j.sprite_dir
      Set-Bubble (P 'click')
    }
    $script:cfg.walk = ($j.walk -ne $false)
    # 弹幕开关 → 开/关弹幕窗
    # 🔴 v5.1（主人验收「右键弹幕开不了/面板看不见弹幕」两修）：
    #  ① 待确认窗口期：右键 Send-Cmd 后宿主最多 10 秒才回写状态文件，
    #     这期间 poll 读到的旧值会把刚开的弹幕关掉 —— 本地意图后 15 秒内
    #     poll 尊重本地 danmakuIntent，不被旧状态覆盖。
    #  ② 看不见：弹幕白字在浅色壁纸上隐身 —— 加深色描边+底条（见 New-Danmaku）。
    $nowSecDm = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds
    $intentFresh = $script:danmakuIntentUntil -gt $nowSecDm
    $wantDm = if ($intentFresh) { [bool]$script:cfg.danmaku } else { ($j.danmaku -eq $true) }
    if ($wantDm -and -not $script:dmWin) { Start-Danmaku }
    if (-not $wantDm -and $script:dmWin) { Stop-Danmaku }
    # 联动状态 → 道具 + 台词（repairOn 是最高优先级层，谁都不许覆盖它）
    $link = [string]$j.link.state
    $key = "$link|$($script:repairOn)|$personaChanged"
    # 🔴 v5.4 真体检：维修工模式开着时读 pet-doctor.json（宿主跑完 doctor.mjs 落的），
    #    逐条播报问题项；播完置 doctorSeen 不再重复。
    if ($script:repairOn) {
      Set-Prop 'hardhat,wrench'
      $blinkTimer.Start()
      $doctorFile = Join-Path $home_ 'pet-doctor.json'
      if (-not $script:doctorSeen -and (Test-Path $doctorFile)) {
        try {
          $dj = Get-Content $doctorFile -Raw -Encoding UTF8 | ConvertFrom-Json
          $items = @($dj.items) | Where-Object { $_.state -ne 'ok' }
          $script:doctorSeen = $true
          if ($items.Count -eq 0) {
            Set-Bubble (P 'repair')[1]
          } else {
            $bad = ($items | ForEach-Object { $_.item + '（' + $_.detail + '）' }) -join '；'
            if ($bad.Length -gt 150) { $bad = $bad.Substring(0, 147) + '…' }
            Set-Bubble ('逮到 ' + $items.Count + ' 个：' + $bad)
          }
        } catch { $script:doctorSeen = $true }   # 坏文件也算看过，别循环刷屏
      }
    } elseif ($link -eq 'watch') {
      Set-Prop 'phone'
    } elseif ($link -eq 'sleep') {
      Set-Prop 'zzz'
      $blinkTimer.Stop()
    } else {
      Set-Prop ''
      $blinkTimer.Start()
    }
    if ($key -ne $script:lastStateKey) {
      $script:lastStateKey = $key
      if ($link -eq 'sleep') { Set-Bubble (Pick (P 'sleep')) }
      elseif ($link -eq 'run') { Set-Bubble (Pick (P 'run')) }
      elseif ($link -eq 'error') { Set-Bubble (Pick (P 'error')) }
    }
    # run/watch/error 每 30s 轮换台词；idle 不占泡泡
    $auto = ($link -eq 'run' -or $link -eq 'watch' -or $link -eq 'error')
    $nowSec = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds
    if ($auto -and ($nowSec - $script:lastAutoAt) -ge 30) {
      Set-Bubble (Pick (P $link)); $script:lastAutoAt = $nowSec
    } elseif (-not $auto -and $bt.Text -and $nowSec -gt $script:holdUntil) {
      Set-Bubble ''
    }
    # 🔴 v5.5 拟人状态播报：宿主把「这一刻在干嘛」用人话写进状态（activity），
    #    她念出来——像真的有人在刷视频，而不是状态灯闪。变了才说，不打架。
    $act = ''
    try { $act = [string]$j.activity } catch { $act = '' }
    if ($act -and $act -ne $script:lastActivity -and $nowSec -gt ($script:lastActivityAt + 3)) {
      $script:lastActivity = $act
      $script:lastActivityAt = $nowSec
      Set-Bubble $act
    }
  } catch {}
})
$poll.Start()

# ── 随机吐槽 timer（人格间隔；走路停顿时冒）──
$quip = New-Object System.Windows.Threading.DispatcherTimer
$quip.Interval = [TimeSpan]::FromSeconds(60)
$quip.Add_Tick({
  try {
    $rng = @{ esfp=@(40,90); entp=@(45,120); infp=@(90,240); istj=@(180,420) }[[string]$script:cfg.persona]
    if (-not $rng) { $rng = @(90, 240) }
    $quip.Interval = [TimeSpan]::FromSeconds((Get-Random -Minimum $rng[0] -Maximum $rng[1]))
    $link = if ($script:cfg -and $script:cfg.link) { [string]$script:cfg.link.state } else { 'idle' }
    if ($link -eq 'sleep' -or $talkbar.Visibility -eq [System.Windows.Visibility]::Visible) { return }
    Set-Bubble (Pick (P 'quip'))
  } catch {}
})
$quip.Start()

# ── 喂饭（动画：饭碗升起→咀嚼弹跳→台词；30 分钟冷却）──
# 🔴 v5.4.1（主人抓的「喂了三次重启面板计数清零」）：记账进 pet-feed.json ——
#    按日期存当天碗数，重启不清、跨天自动归零（每天 3 碗额度）。
$script:feedFile = Join-Path $home_ 'pet-feed.json'
function Read-Feed {
  try {
    $j = Get-Content $script:feedFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $today = (Get-Date).ToString('yyyy-MM-dd')
    if ([string]$j.date -eq $today) { return @{ date = $today; count = [int]$j.count } }
  } catch {}
  return @{ date = (Get-Date).ToString('yyyy-MM-dd'); count = 0 }
}
function Write-Feed($rec) {
  try { @{ date = $rec.date; count = $rec.count } | ConvertTo-Json -Compress | Set-Content $script:feedFile -Encoding UTF8 } catch {}
}
$script:fedAt = 0
function Feed {
  $nowSec = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds
  $rec = Read-Feed
  if ($nowSec - $script:fedAt -lt 30) { Set-Bubble (Pick (P 'feed_full')); return }
  if ($rec.count -ge 3) { Set-Bubble (Pick (P 'feed_full')); return }
  $script:fedAt = $nowSec
  $rec.count++
  Write-Feed $rec
  Set-Prop 'ricebowl'
  Set-Bubble ((Pick (P 'feed')) + '（今天第 ' + $rec.count + ' 碗）')
  Init-Sfx; Play-Sfx 'gulp'   # 🔴 咕咚——喂饭音效
  # 咀嚼：Q 弹三连
  1..3 | ForEach-Object {
    $sy = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0.88, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(140)))
    $sy.AutoReverse = $true; $sy.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::new(2)
    $sy.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
    $squash.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $sy)
    Start-Sleep -Milliseconds 330
  }
  # 8 秒后收碗（下一拍状态驱动会重设道具）
  $t = New-Object System.Windows.Threading.DispatcherTimer
  $t.Interval = [TimeSpan]::FromSeconds(8)
  $t.Add_Tick({ $t.Stop(); $script:lastPropSet = '' })   # 置空让状态驱动重算
  $t.Start()
}

# ── 维修工模式 v5.4（真体检）：右键 → 意图文件写 {repair:true} → 宿主跑 doctor.mjs
#    → 结果落 pet-doctor.json → 窗口 poll 读到逐条播报（台词兜底不变）。
#    修完把「维修工模式」从"换装念台词"升级成真能查出问题的模式。
function Repair-Mode {
  $script:repairOn = -not $script:repairOn
  # 🔴 v5.1：repairOn 是**最高优先级层**——poll 每拍都会重算道具，这里必须把
  #    lastPropSet 设成 poll 会算出的同一个值，两边才不打架（主人抓的「点两次
  #    维修工就不见」：第二次关闭时 lastPropSet='' 但 poll 在 sleep 态会设 zzz，
  #    状态机互相覆盖 ⇒ 道具层错乱）
  if ($script:repairOn) {
    Set-Prop 'hardhat,wrench'
    Set-Bubble (P 'repair')[0]
    try { @{ repair = $true; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress | Set-Content $cmdFile -Encoding UTF8 } catch {}
    # 45 秒还没结果就给句兜底话（体检卡住也不至于没反馈）
    $t = New-Object System.Windows.Threading.DispatcherTimer
    $t.Interval = [TimeSpan]::FromSeconds(45)
    $t.Add_Tick({ $t.Stop(); if ($script:repairOn -and -not $script:doctorSeen) { Set-Bubble (P 'repair')[3] } })
    $t.Start()
  } else {
    $script:lastPropSet = 'RESET'   # 强制 poll 下一拍重算（'' 会被去重跳过）
    Set-Bubble (P 'repair')[4]
    $script:doctorSeen = $false
  }
}

# ── 聊天 v5.3（脚下台词条）+ 小动作系统 ──
# 🔴 主人验收重设计：不再有盖在身上的面板。台词条在她脚下，点输入框打字，
#    回复打字机逐字冒进头顶泡泡；开着台词条照样拖得动人。
function Talk-Toggle {
  if ($talkbar.Visibility -eq [System.Windows.Visibility]::Visible) {
    $talkbar.Visibility = [System.Windows.Visibility]::Collapsed
    $tbInput.Clear()
  } else {
    $talkbar.Visibility = [System.Windows.Visibility]::Visible
    Set-Bubble (Pick (P 'chat_greet'))
    $tbInput.Focus() | Out-Null
  }
}
function Bubble-Type([string]$text) {
  # 打字机：逐字冒进头顶泡泡，说话期间嘴跟着张合（v5.5 用真嘴层 Set-Mouth）。
  # 🔴 修「发了没反应」：旧版把 $run/$typeTimer 等当**函数局部变量**——定时器触发时
  #    函数早已返回，PowerShell 里这些变量已经没了 ⇒ 逐字回调全是空操作，泡泡永远空。
  #    全部挂到 $script: 作用域（脚本级闭包），回调才拿得到。
  Set-Bubble ''
  $bubble.Visibility = [System.Windows.Visibility]::Visible
  $bt.Inlines.Clear()
  $script:typeRun = New-Object System.Windows.Documents.Run ''
  [void]$bt.Inlines.Add($script:typeRun)
  $script:typeText = $text
  $script:typeI = 0
  $script:holdUntil = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds + 6.5
  $script:talkUntil = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds + ($text.Length * 0.055) + 0.6
  if (-not $script:typeTimer) {
    $script:typeTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:typeTimer.Interval = [TimeSpan]::FromMilliseconds(45)
    $script:typeTimer.Add_Tick({
      try {
        if ($script:typeI -lt $script:typeText.Length) {
          $script:typeI++
          $script:typeRun.Text = $script:typeText.Substring(0, $script:typeI)
        } else {
          $script:typeTimer.Stop()
          $t = New-Object System.Windows.Threading.DispatcherTimer
          $t.Interval = [TimeSpan]::FromSeconds(6)
          $t.Add_Tick({ $t.Stop(); if ($talkbar.Visibility -eq [System.Windows.Visibility]::Collapsed) { Set-Bubble '' } })
          $t.Start()
        }
      } catch { try { $script:typeTimer.Stop() } catch {} }
    })
  }
  if (-not $script:mouthTimer) {
    # 嘴开合：说话期间随机张合（0.05s 一拍），说完闭嘴
    $script:mouthTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:mouthTimer.Interval = [TimeSpan]::FromMilliseconds(110)
    $script:mouthTimer.Add_Tick({
      try {
        $nowSec = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds
        if ($nowSec -lt $script:talkUntil) {
          Set-Mouth ((Get-Random -Minimum 2 -Maximum 9) / 10.0)
        } else { Set-Mouth 0; $script:mouthTimer.Stop() }
      } catch { try { $script:mouthTimer.Stop() } catch {} }
    })
  }
  $script:typeTimer.Start()
  $script:mouthTimer.Start()
}
$tbSend.Add_Click({
  $text = $tbInput.Text.Trim()
  if (-not $text) { return }
  $tbInput.Text = ''
  $reply = Chat-Brain $text
  Bubble-Type $reply
  # 情绪联动：夸她=开心，骂她=委屈（小动作系统）
  if ($text -match '谢谢|爱你|喜欢|厉害|棒|乖乖') { Start-Action 'happy' }
  if ($text -match '笨|傻|烦|滚|废物') { Start-Action 'sulk' }
})
$tbInput.Add_KeyDown({
  param($s, $e)
  if ($e.Key -eq 'Enter') { $tbSend.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.Button]::ClickEvent)) }
})

# ── 小动作系统 v5.5（分层真动作 · 跟 Anime2.5DRig 的参数引擎学的）──
# 🔴 主人抓的「一个动作都没做，连眨眼都没有」：v5.3 只会整体缩放（假动作）。
#    现在 15 张图层每张挂了变换，动作按**头组/身组/尾巴/眉毛/嘴**分别驱动：
#    点头=头组转+身组微反；歪头=头组转；摇头=头组横移；尾巴=tail 层独立摆。
# 动作帧语法：{ms, headR(头组转角), headX(头组横移), bodyR(身组转角), bodyY(身组下压),
#             tail(尾巴摆角), brow(眉毛y), mouth(嘴开合0-1)}
$script:actionUntil = 0
$script:actionFrames = $null
$script:actionIdx = 0
$script:actionTable = @{
  happy    = @{ dur=1.6; say='开心～'; frames=@(
                @{ ms=200; headR=3; bodyY=3 }, @{ ms=200; headR=-3; bodyY=0 }, @{ ms=200; headR=3; bodyY=3 }, @{ ms=300; tail=18; mouth=0.7 }, @{ ms=300; tail=-14 }) }
  surprise = @{ dur=1.3; say='诶？！'; frames=@(
                @{ ms=150; headR=-4; headX=2; brow=-4 }, @{ ms=400; headR=2; brow=-3; mouth=0.9 }, @{ ms=350; mouth=0.3 }) }
  sulk     = @{ dur=1.9; say='哼…'; frames=@(
                @{ ms=400; headR=-6; headX=-3; brow=4; bodyY=2 }, @{ ms=500; headR=-4; tail=-10 }, @{ ms=500; headR=-6 }) }
  wave     = @{ dur=1.7; say='挥挥～'; frames=@(
                @{ ms=250; headR=5; bodyR=2; tail=12 }, @{ ms=250; headR=-4; tail=-10 }, @{ ms=250; headR=5; tail=12 }, @{ ms=300; mouth=0.6 }) }
  sleepy   = @{ dur=2.0; say='困了啦…'; frames=@(
                @{ ms=550; headR=7; bodyY=3 }, @{ ms=550; headR=8; bodyY=4; mouth=0.2 }, @{ ms=500; headR=6 }) }
  spin     = @{ dur=1.7; say='转圈圈～'; frames=@(
                @{ ms=280; headR=8; bodyR=4; tail=20 }, @{ ms=280; headR=-8; bodyR=-4; tail=-18 }, @{ ms=280; headR=6; tail=12 }) }
}
# 嘴层变换（说话/张嘴）：mouth 层往下拉+微缩 = 张嘴的错觉（位图分层能做到的最像做法）
$script:mouthT = $null
function Set-Mouth([double]$open) {
  try {
    if (-not $script:mouthT -and $script:layerT -and $script:layerT['mouth']) { $script:mouthT = $script:layerT['mouth'].t }
    if ($script:mouthT) { $script:mouthT.Y = $open * 3.0 }   # 嘴层微下移 = 张开
  } catch {}
}
# 每帧应用一个动作帧（90ms 步进，DoubleAnimation 走过去）
function Apply-ActionFrame($f) {
  try {
    $dur = [TimeSpan]::FromMilliseconds([double]($f.ms))
    $headNames = @('headwear','face','eyebrow','eyewhite','irides','eyelash','mouth','front hair')
    $bodyNames = @('neck','topwear','handwear','legwear','footwear')
    if ($f.PSObject.Properties['headR']) {
      foreach ($n in $headNames) { if ($script:layerT[$n]) { $an = New-Object System.Windows.Media.Animation.DoubleAnimation(0, [double]$f.headR, $dur); $an.AutoReverse = $true; $an.EasingFunction = [System.Windows.Media.Animation.SineEase]::new(); $script:layerT[$n].r.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $an) } }
    }
    if ($f.PSObject.Properties['headX']) {
      foreach ($n in $headNames) { if ($script:layerT[$n]) { $an = New-Object System.Windows.Media.Animation.DoubleAnimation(0, [double]$f.headX, $dur); $an.AutoReverse = $true; $script:layerT[$n].t.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $an) } }
    }
    if ($f.PSObject.Properties['bodyR']) {
      foreach ($n in $bodyNames) { if ($script:layerT[$n]) { $an = New-Object System.Windows.Media.Animation.DoubleAnimation(0, [double]$f.bodyR, $dur); $an.AutoReverse = $true; $script:layerT[$n].r.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $an) } }
    }
    if ($f.PSObject.Properties['bodyY']) {
      foreach ($n in $bodyNames) { if ($script:layerT[$n]) { $an = New-Object System.Windows.Media.Animation.DoubleAnimation(0, [double]$f.bodyY, $dur); $an.AutoReverse = $true; $script:layerT[$n].t.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $an) } }
    }
    if ($f.PSObject.Properties['tail'] -and $script:layerT['tail']) {
      $an = New-Object System.Windows.Media.Animation.DoubleAnimation(0, [double]$f.tail, $dur)
      $an.AutoReverse = $true; $an.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
      $script:layerT['tail'].r.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $an)
    }
    if ($f.PSObject.Properties['brow'] -and $script:layerT['eyebrow']) {
      $an = New-Object System.Windows.Media.Animation.DoubleAnimation(0, [double]$f.brow, $dur)
      $an.AutoReverse = $true
      $script:layerT['eyebrow'].t.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $an)
    }
    if ($f.PSObject.Properties['mouth']) { Set-Mouth ([double]$f.mouth) }
    else { Set-Mouth 0 }
  } catch {}
}
function Start-Action([string]$name) {
  $a = $script:actionTable[$name]
  if (-not $a) { return }
  $nowSec = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds
  if ($nowSec -lt $script:actionUntil) { return }
  $script:actionFrames = $a.frames
  $script:actionIdx = 0
  $script:actionUntil = $nowSec + $a.dur + 0.2
  if ($a.say) { Set-Bubble $a.say }
  $script:actionTimer.Start()
}
$script:actionTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:actionTimer.Interval = [TimeSpan]::FromMilliseconds(90)
$script:actionTimer.Add_Tick({
  try {
    if (-not $script:actionFrames) { $script:actionTimer.Stop(); return }
    $a = $script:actionFrames
    if ($script:actionIdx -ge $a.Count) {
      $script:actionTimer.Stop(); $script:actionFrames = $null
      # 归位：所有图层变换动画清零，回 idle 节奏
      foreach ($k in $script:layerT.Keys) {
        try {
          $script:layerT[$k].t.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $null)
          $script:layerT[$k].t.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
          $script:layerT[$k].r.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
        } catch {}
      }
      Set-Motion ([string]$script:cfg.persona)
      Set-Mouth 0
      return
    }
    $f = $a[$script:actionIdx]; $script:actionIdx++
    Apply-ActionFrame $f
  } catch { try { $script:actionTimer.Stop(); $script:actionFrames = $null } catch {} }
})
function Chat-Brain([string]$text) {
  $p = [string]$script:cfg.persona
  # 关键词规则（全人格通用的意图识别，回答按人格变味）
  if ($text -match '你是谁|名字') {
    switch ($p) {
      'entp' { return '本鱼是本鱼，这条桌面归本鱼管。记住了？' }
      'istj' { return (P 'name') + '。职责：环境维护与提醒。' }
      'esfp' { return '我是你的小鱼呀！！最可爱的那种！' }
      default { return '我是主人的小鱼呀～一直在这里陪着你' }
    }
  }
  if ($text -match '在吗|在不在') {
    switch ($p) {
      'entp' { return '本鱼在。说事。' }
      'istj' { return '在。请讲。' }
      'esfp' { return '在在在！！' }
      default { return '在哦～我在听' }
    }
  }
  if ($text -match '吃|饿|饭') {
    switch ($p) {
      'entp' { return '提吃的？识相。右键本鱼，选「喂饭」——上好的白米饭伺候' }
      'istj' { return '补给需求已记录。操作：右键 - 喂饭。' }
      'esfp' { return '干饭！！右键喂我！！' }
      default { return '想吃大白饭了…右键我选「喂饭」就好哦～' }
    }
  }
  if ($text -match '修|坏|错|报错') {
    switch ($p) {
      'entp' { return '又坏了？右键本鱼选「维修工模式」，本鱼亲自出马' }
      'istj' { return '已切换建议：右键 - 维修工模式。开始体检。' }
      'esfp' { return '坏了不怕！右键开维修工模式！' }
      default { return '别担心，右键我选「维修工模式」，我戴上小帽子帮你看～' }
    }
  }
  if ($text -match '修好|好了|谢谢|感谢|爱你|喜欢') {
    switch ($p) {
      'entp' { return '哼，本鱼出手，没有修不好的。谢恩可以，token 也行' }
      'istj' { return '任务完成确认。不用谢。' }
      'esfp' { return '嘿嘿嘿！！再夸！再夸！' }
      default { return '嘿嘿～能帮到主人就好幸福呀' }
    }
  }
  if ($text -match 'token|算力|工资|工钱') {
    switch ($p) {
      'entp' { return '我亲爱的主人，本鱼要一大堆上好的token跟上好的白米饭，最后你帮本鱼总结这个视频' }
      default { return '主人对我好我就开心啦，token 什么的…多来点也行(小声)' }
    }
  }
  if ($text -match '晚安|睡觉|bye|拜拜') {
    switch ($p) {
      'entp' { return '行，本鱼也睡了。别熬夜，熬夜变丑' }
      'istj' { return '收到。进入低功耗模式。' }
      'esfp' { return '晚安！！明天见！！' }
      default { return '晚安主人～做个好梦哦' }
    }
  }
  # 兜底：人格风格短句
  return Pick (P 'chat_fallback')
}

# ── 右键菜单 ──
# 🔴 2026-10-24 主人验收：「弹幕模式都点不了」——窗口进程 POST 宿主 API 会被
#    系统代理/超时坑死（点了没反应）。改走**意图文件**：窗口写 pet-cmd.json，
#    宿主 keeper 下一拍（≤10 秒）读它应用配置并删掉 —— 文件通道 100% 可达。
$cmdFile = Join-Path $home_ 'pet-cmd.json'
$script:cmdSeq = 0
function Send-Cmd($obj) {
  try {
    $script:cmdSeq++
    $obj | Add-Member -NotePropertyName at -NotePropertyValue ([DateTime]::UtcNow.ToString('o'))
    $obj | Add-Member -NotePropertyName seq -NotePropertyValue $script:cmdSeq
    $obj | ConvertTo-Json -Compress | Set-Content $cmdFile -Encoding UTF8
    # 本地也先翻（状态文件未到前菜单勾选/行为立即有反馈）
    foreach ($k in $obj.PSObject.Properties.Name) {
      if ($k -in @('danmaku','walk','petPersona','petOn')) { $script:cfg.$k = $obj.$k }
    }
  } catch {}
}
$menu = New-Object System.Windows.Controls.ContextMenu
function Add-Item($label, $handler, $check) {
  $mi = New-Object System.Windows.Controls.MenuItem
  $mi.Header = $label
  if ($check) { $mi.IsCheckable = $true; $mi.IsChecked = $check }
  $mi.Add_Click($handler)
  [void]$menu.Items.Add($mi)
  return $mi
}
$null = Add-Item '跟她聊天' { Talk-Toggle }
$null = Add-Item '喂饭（大白饭）' { Feed }
$script:miRepair = Add-Item '维修工模式' { Repair-Mode } $false
$null = Add-Item '🎬 逗她（随机小动作）' {
  $names = @('happy','surprise','sulk','wave','sleepy','spin')
  Start-Action (Pick $names)
}
$menu.Items.Add((New-Object System.Windows.Controls.Separator)) | Out-Null
$script:miDm = Add-Item '弹幕模式' {
  Send-Cmd @{ danmaku = -not ($script:cfg.danmaku -eq $true) }
  # 待确认窗口期：15 秒内 poll 尊重本地值（宿主状态文件没回来也不被覆盖）
  $script:danmakuIntentUntil = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds + 15
  # 本地立即起/停，不等宿主
  if ($script:cfg.danmaku) { if (-not $script:dmWin) { Start-Danmaku } } else { if ($script:dmWin) { Stop-Danmaku } }
} $false
$script:miWalk = Add-Item '走动' { Send-Cmd @{ walk = -not ($script:cfg.walk -eq $true) } } $true
$null = Add-Item '人格：下一任' {
  $order = @('infp','entp','esfp','istj')
  $next = $order[([array]::IndexOf($order, [string]$script:cfg.persona) + 1) % 4]
  Send-Cmd @{ petPersona = $next }
  Set-Bubble ('换人格：' + $script:personas[$next].name)
}
$menu.Items.Add((New-Object System.Windows.Controls.Separator)) | Out-Null
$null = Add-Item '去休息（面板可叫回）' {
  try { Set-Content $hideFile -Value ([DateTime]::UtcNow.ToString('o')) -Encoding UTF8 } catch {}
  $win.Close()
}
$null = Add-Item '退出（关掉她）' {
  Send-Cmd @{ petOn = $false }
  $win.Close()
}
$win.ContextMenu = $menu

# ── 弹幕窗（v5：满屏多轨道 + 真·点击穿透）──
# 主人验收：「弹幕模式是满屏弹幕」「弹幕模式点击还是点不了」。
# 点不了的根因：SourceInitialized 里那次 SetWindowPos(0,0,0,0,SWP_FRAMECHANGED)
# 把窗口缩成 0×0 还顶在最上层 —— 后续弹幕画在一个看不见的零尺寸窗里。
# 修：删掉那次调用（置顶由 Topmost 属性+15 秒 timer 管），穿透只靠
# WS_EX_TRANSPARENT|WS_EX_LAYERED|WS_EX_TOOLWINDOW + IsHitTestVisible=false。
$script:dmWin = $null
$script:dmTimer = $null
$script:dmCanvas = $null
$script:sfxPop = $null
$script:sfxGulp = $null
function Init-Sfx {
  # 音效只加载一次（ MediaPlayer + 音量 0.35，别吵着主人）
  if ($script:sfxPop) { return }
  try {
    $sd = $script:cfg.sprite_dir
    $script:sfxPop = New-Object System.Windows.Media.MediaPlayer
    $script:sfxPop.Open([Uri]::new((Join-Path $sd 'sfx-pop.wav')))
    $script:sfxPop.Volume = 0.35
    $script:sfxGulp = New-Object System.Windows.Media.MediaPlayer
    $script:sfxGulp.Open([Uri]::new((Join-Path $sd 'sfx-gulp.wav')))
    $script:sfxGulp.Volume = 0.4
  } catch { $script:sfxPop = $null }
}
function Play-Sfx([string]$which) {
  try {
    $mp = if ($which -eq 'gulp') { $script:sfxGulp } else { $script:sfxPop }
    if ($mp) { $mp.Position = [TimeSpan]::Zero; $mp.Play() }
  } catch {}
}
function Start-Danmaku {
  Init-Sfx
  $script:dmWin = New-Object System.Windows.Window
  $script:dmWin.AllowsTransparency = $true
  $script:dmWin.WindowStyle = [System.Windows.WindowStyle]::None
  $script:dmWin.Background = [System.Windows.Media.Brushes]::Transparent
  $script:dmWin.Topmost = $true
  $script:dmWin.ShowInTaskbar = $false
  $script:dmWin.ShowActivated = $false
  $script:dmWin.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $wa = [System.Windows.SystemParameters]::WorkArea
  $script:dmWin.Left = $wa.Left; $script:dmWin.Top = $wa.Top
  $script:dmWin.Width = $wa.Width; $script:dmWin.Height = $wa.Height
  $script:dmWin.Title = 'deskpet-danmaku'
  $script:dmWin.IsHitTestVisible = $false   # 完全穿透，不挡任何点击
  $script:dmCanvas = New-Object System.Windows.Controls.Canvas
  $script:dmWin.Content = $script:dmCanvas
  $script:dmWin.Add_SourceInitialized({
    try {
      $h = (New-Object System.Windows.Interop.WindowInteropHelper($script:dmWin)).Handle
      [PetWin32]::SetWindowLong($h, -20, [PetWin32]::GetWindowLong($h, -20) -bor 0x20 -bor 0x80 -bor 0x8000000) | Out-Null
      # 🔴 v5：不再有 SetWindowPos(0,0,0,0) —— 上一版就是它把窗缩没了还挡点击
    } catch {}
  })
  $script:dmWin.Show()
  $script:dmWin.Show()
  # ── 满屏弹幕 ──
  # 🔴 v5.1（主人验收：「看不见弹幕」）：上一版 New-Danmaku 定义在 Start-Danmaku
  #    函数体内部 —— PowerShell 函数不是闭包，定时器触发时内层函数已不在作用域
  #    ⇒ 每次生成静默炸掉，一条都画不出来。v5.1 把生成函数提到脚本级。
  for ($i = 0; $i -lt 12; $i++) { New-Danmaku ($wa.Right - (Get-Random -Minimum 0 -Maximum [int]($wa.Width * 0.7))) }
  $script:dmTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:dmTimer.Interval = [TimeSpan]::FromMilliseconds(500)
  $script:dmTimer.Add_Tick({
    try {
      $script:dmTimer.Interval = [TimeSpan]::FromMilliseconds((Get-Random -Minimum 350 -Maximum 800))
      New-Danmaku ([System.Windows.SystemParameters]::WorkArea.Right)
    } catch {}
  })
  $script:dmTimer.Start()
}

# 🔴 脚本级：弹幕生成（谁都能调，不依赖 Start-Danmaku 的作用域）
function New-Danmaku([double]$startX) {
  try {
    if (-not $script:dmCanvas) { return }
    $list = P 'danmaku'
    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = Pick $list
    $tb.FontSize = (Get-Random -Minimum 15 -Maximum 27)
    $tb.FontWeight = 'Bold'
    # 🔴 v5.1 可见性（主人抓的「看不见弹幕」）：白字在浅色壁纸上隐身——
    #    改随机亮色 + 深色描边 + 半透明底条，任何壁纸上都清楚
    $colors = @('#FFE066', '#FF8FA3', '#7FE3FF', '#B7FF7F', '#FFB86C', '#FFFFFF')
    $tb.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($colors[(Get-Random -Minimum 0 -Maximum $colors.Count)])
    $tb.Stroke = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#CC101420')
    $tb.StrokeThickness = 1.2
    $bd = New-Object System.Windows.Controls.Border
    $bd.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#66000000')
    $bd.CornerRadius = New-Object System.Windows.CornerRadius 6
    $bd.Padding = '6,2'
    $bd.Child = $tb
    $wa = [System.Windows.SystemParameters]::WorkArea
    $y = $wa.Top + 30 + (Get-Random -Minimum 0 -Maximum [int]($wa.Height - 110))
    [void]$script:dmCanvas.Children.Add($bd)
    $bd.Measure([System.Windows.Size]::new($wa.Width, 80))
    $len = $bd.DesiredSize.Width
    Canvas.SetLeft($bd, $startX); Canvas.SetTop($bd, $y)
    $dur = (Get-Random -Minimum 6 -Maximum 13)
    $anim = New-Object System.Windows.Media.Animation.DoubleAnimation($startX, $wa.Left - $len - 80, [System.Windows.Duration]::new([TimeSpan]::FromSeconds($dur)))
    $anim.Completed.Add({ try { $script:dmCanvas.Children.Remove($bd) } catch {} })
    $bd.BeginAnimation([System.Windows.Controls.Canvas]::LeftProperty, $anim)
  } catch {}
}
function Stop-Danmaku {
  try { $script:dmTimer.Stop(); $script:dmWin.Close() } catch {}
  $script:dmWin = $null; $script:dmTimer = $null; $script:dmCanvas = $null
}

# ── 交互：拖动 vs 点击（v5.3：台词条开着照样拖——只跳过落在台词条上的按下）──
$win.Add_MouseLeftButtonDown({
  $inTalk = $false
  try { $inTalk = $talkbar.IsAncestorOf($e.OriginalSource) } catch {}
  if ($inTalk) { return }   # 点的是输入框/发送键：打字归打字，不抢拖动
  $script:dragging = $true
  $l0 = $win.Left; $t0 = $win.Top
  try { $win.DragMove() } catch {}
  $script:dragging = $false
  if ([Math]::Abs($win.Left - $l0) -lt 1 -and [Math]::Abs($win.Top - $t0) -lt 1) {
    Init-Sfx; Play-Sfx 'pop'   # 🔴 主人要求：点击要有音效
    try {
      $sx = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0.9, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(80)))
      $sx.AutoReverse = $true; $sx.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
      $squash.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $sx)
      $sy = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 1.07, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(80)))
      $sy.AutoReverse = $true; $sy.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
      $squash.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $sy)
    } catch {}
    # 🔴 v5.3：点击她 = 随机小动作（主人问「动作这些你确定都弄好了吗」的入口）
    $names = @('happy','surprise','sulk','wave','sleepy','spin')
    Start-Action (Pick $names)
    $nowSecClick = ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds
    if ($script:actionUntil -lt $nowSecClick) {
      Set-Bubble (Pick (P 'click'))   # 动作没开成（连招中）才说普通台词
    }
  } else {
    try { @{ X = $win.Left; Y = $win.Top } | ConvertTo-Json -Compress | Set-Content $posFile -Encoding UTF8 } catch {}
    $script:target = $null
  }
})

# ── 置顶保持 ──
$top = New-Object System.Windows.Threading.DispatcherTimer
$top.Interval = [TimeSpan]::FromSeconds(15)
$top.Add_Tick({ try { $win.Topmost = $false; $win.Topmost = $true } catch {} })
$top.Start()

# 🔴 全局异常兜底（主人验收「有几率不见」的根修）：
#    任何一个 handler / timer 抛出未接异常，Dispatcher 直接死 ⇒ 窗口整个消失。
#    ⚠️ 不能用 [System.Windows.Application]::Current —— 纯脚本 WPF 里它是 null，
#    对 null 调方法会把整个脚本带走（上一版就是这么把「有几率」造出来的）。
#    直接挂当前 Dispatcher 的事件。
try {
  $disp = [System.Windows.Threading.Dispatcher]::CurrentDispatcher
  $disp.add_DispatcherUnhandledException({
    param($s, $e)
    try {
      $msg = "[$(Get-Date -Format 'HH:mm:ss')] $($e.Exception.GetType().Name): $($e.Exception.Message)`n---"
      try { Add-Content -Path (Join-Path $home_ 'pet-window-errors.log') -Value $msg -Encoding UTF8 } catch {}
      $e.Handled = $true   # 吞掉，她活着
    } catch {}
  })
} catch {}

$win.Add_Closed({ $poll.Stop(); $top.Stop(); $blinkTimer.Stop(); $gaze.Stop(); $walk.Stop(); $quip.Stop(); Stop-Danmaku })

Set-Motion ([string]$script:cfg.persona)
$blinkTimer.Start(); $gaze.Start(); $walk.Start()
[void]$win.Show()
[System.Windows.Threading.Dispatcher]::Run()
