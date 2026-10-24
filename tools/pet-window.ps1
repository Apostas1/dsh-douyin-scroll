# pet-window.ps1 —— 桌宠桌面窗口（WPF 置顶透明窗，2026-10-24 v2）
# ============================================================================
# 主人指令：「桌宠模式是悬浮在所有窗口上的」——网页浮层出不了 DSH 窗口，
# 所以她是独立进程的置顶小窗：Topmost + 无边框 + 全透明 + 不进任务栏/Alt-Tab。
# 插件（index.js 的 petKeeper）拉起本脚本，每 15 秒写 pet-window-state.json；
# 这里 2 秒一读，状态变了就换道具/泡泡。右键 = 她去休息（写 pet-hide.json，
# 面板重新打开开关她才回来）。状态文件 90 秒没更新（宿主没了）自己也退，不赖着。
# ============================================================================
param()

$ErrorActionPreference = 'Stop'
$home_ = $env:DOUYIN_HOME
if (-not $home_) { exit 1 }
$stateFile = Join-Path $home_ 'pet-window-state.json'
$posFile   = Join-Path $home_ 'pet-window-pos.json'
$hideFile  = Join-Path $home_ 'pet-hide.json'

# ── 泡泡台词（跟人格走的部分以后从状态文件读；先内置默认版）──
$bubbles = @{
  idle  = @('在呢在呢～', '发呆中…', '今天吃什么好呢', '摸鱼…啊不，巡逻中')
  watch = @('盯着私信呢…', '手机抱着，消息一来就知道', '嘘——在看消息')
  run   = @('刷抖音中，别吵！', '挑好玩的呢，稍等', '这一轮快跑完了…')
  sleep = @('Zzz…（时段和聊天模式都关了）', '睡着了，到点会自己醒')
  error = @('呜…刚才那下出错了', '撞到什么了，下一拍再试')
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# ── 窗口 ──
$win = New-Object System.Windows.Window
$win.AllowsTransparency = $true
$win.WindowStyle        = [System.Windows.WindowStyle]::None
$win.Background         = [System.Windows.Media.Brushes]::Transparent
$win.Topmost            = $true
$win.ShowInTaskbar      = $false
$win.ShowActivated      = $false
$win.ResizeMode         = [System.Windows.ResizeMode]::NoResize
$win.Width              = 180
$win.Height             = 230
$win.Title              = 'deskpet'

# 默认位置：主屏右下角
try {
  $pos = Get-Content $posFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($pos.X -is [double] -and $pos.Y -is [double]) { $win.Left = $pos.X; $win.Top = $pos.Y }
  else { throw 'bad' }
} catch {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $wa.Right - $win.Width - 24
  $win.Top  = $wa.Bottom - $win.Height - 16
}

# 不进 Alt-Tab：加 WS_EX_TOOLWINDOW
$win.Add_SourceInitialized({
  try {
    $src = [System.Windows.PresentationSource]::FromVisual($win)
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Pet {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
}
"@
    $h = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
    [Win32Pet]::SetWindowLong($h, -20, [Win32Pet]::GetWindowLong($h, -20) -bor 0x80) | Out-Null
  } catch {}
})

# ── 内容：泡泡（上）+ 身体层（下）──
$root = New-Object System.Windows.Controls.Grid
$root.VerticalAlignment = 'Bottom'
$root.HorizontalAlignment = 'Center'
$root.Width = 140
$root.Height = 190

$bubble = New-Object System.Windows.Controls.Border
$bubble.CornerRadius = New-Object System.Windows.CornerRadius 10
$bubble.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#E61E2028')
$bubble.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#59FFFFFF')
$bubble.BorderThickness = '1'
$bubble.Padding = '8,6'
$bubble.HorizontalAlignment = 'Center'
$bubble.VerticalAlignment = 'Top'
$bubble.Margin = '0,0,30,0'
$bubble.MaxWidth = 170
$bt = New-Object System.Windows.Controls.TextBlock
$bt.Text = ''
$bt.FontSize = 11
$bt.Foreground = [System.Windows.Media.Brushes]::White
$bt.TextWrapping = 'Wrap'
$bubble.Child = $bt
[void]$root.Children.Add($bubble)

$body = New-Object System.Windows.Controls.Grid
$body.Width = 140
$body.Height = 140
$body.VerticalAlignment = 'Bottom'
$float = New-Object System.Windows.Media.TranslateTransform
$body.RenderTransform = $float
[void]$root.Children.Add($body)

$win.Content = $root

# ── 状态文件读取 ──
function Read-State {
  try {
    $j = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($j.sprite_dir) { return $j }
  } catch {}
  return $null
}

$script:layerImgs = @{}
$script:propImg = $null
$script:lastProp = ''
$script:lastBubble = ''
$script:lastAutoAt = 0

function Build-Bitmap($path) {
  $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
  $bmp.BeginInit()
  $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bmp.UriSource = [Uri]::new($path)
  $bmp.EndInit()
  $bmp.Freeze()
  return $bmp
}

function Apply-State($j) {
  $state = if ($j.state) { [string]$j.state } else { 'idle' }
  # 身体层：第一次加载，之后不动（层图不变）
  if (-not $script:layerImgs.Count) {
    foreach ($n in @('back hair','tail','legwear','footwear','neck','topwear','handwear','headwear','face','eyebrow','eyewhite','irides','eyelash','mouth','front hair')) {
      $img = New-Object System.Windows.Controls.Image
      $img.Stretch = 'Uniform'
      $img.Source = Build-Bitmap (Join-Path $j.sprite_dir ("layers\" + $n + ".png"))
      [void]$body.Children.Add($img)
      $script:layerImgs[$n] = $img
    }
    # 眨眼动画：eyelash 压扁再弹回（RenderTransformOrigin 对准眼睛中心）
    $lash = $script:layerImgs['eyelash']
    $lash.RenderTransformOrigin = '0.5,0.42'
    $st = New-Object System.Windows.Media.ScaleTransform
    $lash.RenderTransform = $st
    $blink = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0.08, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(90)))
    $blink.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::new([TimeSpan]::FromSeconds(4.6))
    $st.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $blink)
    # 呼吸浮动：整只身体 ±5px
    $up = New-Object System.Windows.Media.Animation.DoubleAnimation(0, -5, [System.Windows.Duration]::new([TimeSpan]::FromSeconds(1.6)))
    $up.AutoReverse = $true
    $up.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
    $up.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
    $float.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $up)
  }
  # 道具：watch=phone / sleep=zzz / 其它=收起
  $prop = if ($state -eq 'watch') { 'phone.png' } elseif ($state -eq 'sleep') { 'zzz.png' } else { '' }
  if ($prop -ne $script:lastProp) {
    if ($script:propImg) { $body.Children.Remove($script:propImg) }
    $script:propImg = $null
    if ($prop) {
      $script:propImg = New-Object System.Windows.Controls.Image
      $script:propImg.Stretch = 'Uniform'
      $script:propImg.Source = Build-Bitmap (Join-Path $j.sprite_dir $prop)
      [void]$body.Children.Add($script:propImg)
    }
    $script:lastProp = $prop
  }
  # 泡泡：run/watch/error 自动轮换一句（30 秒换）；idle/sleep 只在点击时冒
  $auto = ($state -eq 'run' -or $state -eq 'watch' -or $state -eq 'error')
  if ($auto -and ((Get-Date).ToUniversalTime().Subtract([DateTime]::new(1970,1,1)).TotalSeconds - $script:lastAutoAt) -ge 30) {
    $list = $bubbles[$state]
    $bt.Text = $list[(Get-Random -Minimum 0 -Maximum $list.Count)]
    $script:lastAutoAt = (Get-Date).ToUniversalTime().Subtract([DateTime]::new(1970,1,1)).TotalSeconds
  } elseif (-not $auto -and $bt.Text) {
    $bt.Text = ''
  }
}

# ── 交互 ──
# 左键：DragMove；没拖动（位置没变）算点击 → 冒一句
$win.Add_MouseLeftButtonDown({
  $l0 = $win.Left; $t0 = $win.Top
  try { $win.DragMove() } catch {}
  if ([Math]::Abs($win.Left - $l0) -lt 1 -and [Math]::Abs($win.Top - $t0) -lt 1) {
    $j = Read-State
    $state = if ($j -and $j.state) { [string]$j.state } else { 'idle' }
    if (-not $bubbles.ContainsKey($state)) { $state = 'idle' }
    $list = $bubbles[$state]
    $bt.Text = $list[(Get-Random -Minimum 0 -Maximum $list.Count)]
  } else {
    try { @{ X = $win.Left; Y = $win.Top } | ConvertTo-Json -Compress | Set-Content $posFile -Encoding UTF8 } catch {}
  }
})
# 右键：去休息（面板重新打开桌宠开关她才回来）
$win.Add_MouseRightButtonDown({
  try { Set-Content $hideFile -Value ([DateTime]::UtcNow.ToString('o')) -Encoding UTF8 } catch {}
  $win.Close()
})

# ── 轮询：2 秒读状态；15 秒顶一次置顶；90 秒没新状态 = 宿主没了 → 退 ──
$poll = New-Object System.Windows.Threading.DispatcherTimer
$poll.Interval = [TimeSpan]::FromSeconds(2)
$poll.Add_Tick({
  try {
    if (-not (Test-Path $stateFile)) { $win.Close(); return }
    $age = ([DateTime]::UtcNow - (Get-Item $stateFile).LastWriteTimeUtc).TotalSeconds
    if ($age -gt 90) { $win.Close(); return }
    $j = Read-State
    if ($j) { Apply-State $j }
  } catch {}
})
$poll.Start()

$top = New-Object System.Windows.Threading.DispatcherTimer
$top.Interval = [TimeSpan]::FromSeconds(15)
$top.Add_Tick({ try { $win.Topmost = $false; $win.Topmost = $true } catch {} })
$top.Start()

$win.Add_Closed({ $poll.Stop(); $top.Stop() })

[void]$win.Show()
[System.Windows.Threading.Dispatcher]::Run()
