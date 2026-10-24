# pet-window.ps1 —— 桌宠桌面窗口（WPF 置顶透明窗，2026-10-24 v3）
# ============================================================================
# 主人指令：「悬浮在所有窗口上」+ 验收反馈「她没动作」「头上一直悬空对话框」。
# v3 动画层：呼吸浮动 + 绕脚底左右轻摆 + 随机眨眼 + 点击 Q 弹（squash&stretch）
#           + 状态节奏（run 快 / sleep 慢而深）+ 空台词时泡泡整个隐藏。
# 右键 = 去休息（pet-hide.json，面板开关关一次再开她才回来）。
# 状态文件 90 秒没更新（宿主没了）自己退，不赖着。
# ============================================================================
param()

$ErrorActionPreference = 'Stop'
$home_ = $env:DOUYIN_HOME
if (-not $home_) { exit 1 }
$stateFile = Join-Path $home_ 'pet-window-state.json'
$posFile   = Join-Path $home_ 'pet-window-pos.json'
$hideFile  = Join-Path $home_ 'pet-hide.json'

$bubbles = @{
  idle  = @('在呢在呢～', '发呆中…', '今天吃什么好呢', '摸鱼…啊不，巡逻中')
  watch = @('盯着私信呢…', '手机抱着，消息一来就知道', '嘘——在看消息')
  run   = @('刷抖音中，别吵！', '挑好玩的呢，稍等', '这一轮快跑完了…')
  sleep = @('Zzz…（时段和聊天模式都关了）', '睡着了，到点会自己醒')
  error = @('呜…刚才那下出错了', '撞到什么了，下一拍再试')
}

function Now-Unix { ([DateTime]::UtcNow - [DateTime]::new(1970,1,1)).TotalSeconds }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

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

try {
  $pos = Get-Content $posFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($pos.X -is [double] -and $pos.Y -is [double]) { $win.Left = $pos.X; $win.Top = $pos.Y }
  else { throw 'bad' }
} catch {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $wa.Right - $win.Width - 24
  $win.Top  = $wa.Bottom - $win.Height - 16
}

$win.Add_SourceInitialized({
  try {
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

# ── 内容：泡泡（上）+ 身体（下）──
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
# 🔴 没台词就整个藏起来 —— 不许再悬一个空框在头上（主人 2026-10-24 抓的）
$bubble.Visibility = [System.Windows.Visibility]::Collapsed
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
# 变换组：float（呼吸上下）+ sway（绕脚底左右摆）+ squash（点击 Q 弹）
$float  = New-Object System.Windows.Media.TranslateTransform
$sway   = New-Object System.Windows.Media.RotateTransform
$squash = New-Object System.Windows.Media.ScaleTransform
$tg = New-Object System.Windows.Media.TransformGroup
[void]$tg.Children.Add($float)
[void]$tg.Children.Add($sway)
[void]$tg.Children.Add($squash)
$body.RenderTransform = $tg
$body.RenderTransformOrigin = '0.5,0.9'   # 绕脚底摆，像在水里晃
[void]$root.Children.Add($body)

$win.Content = $root

function Read-State {
  try {
    $j = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($j.sprite_dir) { return $j }
  } catch {}
  return $null
}

function Build-Bitmap($path) {
  $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
  $bmp.BeginInit()
  $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bmp.UriSource = [Uri]::new($path)
  $bmp.EndInit()
  $bmp.Freeze()
  return $bmp
}

# 统一的泡泡写法：有字 → 显示；没字 → 整个收起
function Set-Bubble([string]$text) {
  if ($text) {
    $bt.Text = $text
    $bubble.Visibility = [System.Windows.Visibility]::Visible
  } else {
    $bt.Text = ''
    $bubble.Visibility = [System.Windows.Visibility]::Collapsed
  }
}

# ── 动画：按状态定节奏（先清旧动画再开新的，别叠加）──
function Set-Motion([string]$state) {
  # float：上下呼吸 amp(px) / period(s)
  $f = @{ idle = @(5, 2.4); watch = @(3, 2.0); run = @(4, 1.1); sleep = @(7, 3.4); error = @(3, 1.6) }[$state]
  if (-not $f) { $f = @(5, 2.4) }
  $float.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $up = New-Object System.Windows.Media.Animation.DoubleAnimation(0, -$f[0], [System.Windows.Duration]::new([TimeSpan]::FromSeconds($f[1])))
  $up.AutoReverse = $true
  $up.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $up.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
  $float.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $up)
  # sway：左右轻摆 deg / period(s)
  $s = @{ idle = @(1.8, 3.2); watch = @(1.2, 2.6); run = @(2.6, 1.3); sleep = @(0.8, 5.0); error = @(1.0, 2.0) }[$state]
  if (-not $s) { $s = @(1.8, 3.2) }
  $sway.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
  $rl = New-Object System.Windows.Media.Animation.DoubleAnimation(-$s[0], $s[0], [System.Windows.Duration]::new([TimeSpan]::FromSeconds($s[1])))
  $rl.AutoReverse = $true
  $rl.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $rl.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
  $sway.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $rl)
}

$script:layerImgs = @{}
$script:propImg = $null
$script:lastProp = ''
$script:lastState = ''
$script:lastAutoAt = 0

# ── 眨眼：随机 2.8–5.2 秒眨一次（一次性动画，播完靠 timer 再触发）──
$lashScale = New-Object System.Windows.Media.ScaleTransform
$blinkTimer = New-Object System.Windows.Threading.DispatcherTimer
$blinkTimer.Add_Tick({
  try {
    $blinkTimer.Interval = [TimeSpan]::FromMilliseconds((Get-Random -Minimum 2800 -Maximum 5200))
    $blink = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0.06, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(90)))
    $blink.AutoReverse = $true
    $blink.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
    $lashScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $blink)
  } catch {}
})
# 睡觉不眨眼（闭着眼呢）——timer 在 Apply-State 里按状态开关

function Apply-State($j) {
  $state = if ($j.state) { [string]$j.state } else { 'idle' }
  if (-not $bubbles.ContainsKey($state)) { $state = 'idle' }
  if ($state -ne $script:lastState) {
    Set-Motion $state
    if ($state -eq 'sleep') { $blinkTimer.Stop() } else { $blinkTimer.Start() }
    $script:lastState = $state
  }
  if (-not $script:layerImgs.Count) {
    foreach ($n in @('back hair','tail','legwear','footwear','neck','topwear','handwear','headwear','face','eyebrow','eyewhite','irides','eyelash','mouth','front hair')) {
      $img = New-Object System.Windows.Controls.Image
      $img.Stretch = 'Uniform'
      $img.Source = Build-Bitmap (Join-Path $j.sprite_dir ("layers\" + $n + ".png"))
      [void]$body.Children.Add($img)
      $script:layerImgs[$n] = $img
    }
    # 眨眼只动 eyelash 层（origin 对准眼睛）
    $lash = $script:layerImgs['eyelash']
    $lash.RenderTransformOrigin = '0.5,0.42'
    $lash.RenderTransform = $lashScale
    $blinkTimer.Start()
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
      # 道具自己轻轻上下飘（拿着手机晃 / Zzz 上浮）
      $pf = New-Object System.Windows.Media.TranslateTransform
      $script:propImg.RenderTransform = $pf
      $pu = New-Object System.Windows.Media.Animation.DoubleAnimation(0, -3, [System.Windows.Duration]::new([TimeSpan]::FromSeconds(1.8)))
      $pu.AutoReverse = $true
      $pu.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
      $pu.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
      $pf.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $pu)
      [void]$body.Children.Add($script:propImg)
    }
    $script:lastProp = $prop
  }
  # 泡泡：run/watch/error 每 30 秒轮换一句；idle/sleep 不自动冒（点击才说话）
  $auto = ($state -eq 'run' -or $state -eq 'watch' -or $state -eq 'error')
  if ($auto -and ((Now-Unix) - $script:lastAutoAt) -ge 30) {
    $list = $bubbles[$state]
    Set-Bubble $list[(Get-Random -Minimum 0 -Maximum $list.Count)]
    $script:lastAutoAt = Now-Unix
  } elseif (-not $auto -and $bt.Text) {
    Set-Bubble ''
  }
}

# ── 交互 ──
$win.Add_MouseLeftButtonDown({
  $l0 = $win.Left; $t0 = $win.Top
  try { $win.DragMove() } catch {}
  if ([Math]::Abs($win.Left - $l0) -lt 1 -and [Math]::Abs($win.Top - $t0) -lt 1) {
    # 点击：Q 弹一下 + 冒一句
    try {
      $sx = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0.9, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(80)))
      $sx.AutoReverse = $true
      $sx.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
      $squash.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $sx)
      $sy = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 1.07, [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(80)))
      $sy.AutoReverse = $true
      $sy.EasingFunction = [System.Windows.Media.Animation.SineEase]::new()
      $squash.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $sy)
    } catch {}
    $j = Read-State
    $state = if ($j -and $j.state) { [string]$j.state } else { 'idle' }
    if (-not $bubbles.ContainsKey($state)) { $state = 'idle' }
    $list = $bubbles[$state]
    Set-Bubble $list[(Get-Random -Minimum 0 -Maximum $list.Count)]
  } else {
    try { @{ X = $win.Left; Y = $win.Top } | ConvertTo-Json -Compress | Set-Content $posFile -Encoding UTF8 } catch {}
  }
})
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

$win.Add_Closed({ $poll.Stop(); $top.Stop(); $blinkTimer.Stop() })

[void]$win.Show()
[System.Windows.Threading.Dispatcher]::Run()
