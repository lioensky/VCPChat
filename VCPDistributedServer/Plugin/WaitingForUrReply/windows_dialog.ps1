# Windows PowerShell 5.1 / WPF / STA. No user text is evaluated as code.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
    $xamlText = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="620" SizeToContent="Height" WindowStartupLocation="CenterScreen"
        WindowStyle="None" ResizeMode="NoResize" AllowsTransparency="True"
        Background="Transparent" FontFamily="Segoe UI, Microsoft YaHei UI"
        FontSize="14" Foreground="#EDF3F1">
 <Window.Resources>
  <Style TargetType="Button">
   <Setter Property="Foreground" Value="#B7C7C2"/>
   <Setter Property="Background" Value="#202D29"/>
   <Setter Property="BorderBrush" Value="#35483F"/>
   <Setter Property="BorderThickness" Value="1"/>
   <Setter Property="Padding" Value="15,10"/>
   <Setter Property="Cursor" Value="Hand"/>
   <Setter Property="Template">
    <Setter.Value>
     <ControlTemplate TargetType="Button">
      <Border x:Name="Surface" Background="{TemplateBinding Background}"
              BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}"
              CornerRadius="10" Padding="{TemplateBinding Padding}">
       <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}"
                         VerticalAlignment="Center"/>
      </Border>
      <ControlTemplate.Triggers>
       <Trigger Property="IsMouseOver" Value="True">
        <Setter TargetName="Surface" Property="Opacity" Value="0.78"/>
       </Trigger>
       <Trigger Property="IsKeyboardFocused" Value="True">
        <Setter TargetName="Surface" Property="BorderBrush" Value="#86E5BA"/>
       </Trigger>
       <Trigger Property="IsPressed" Value="True">
        <Setter TargetName="Surface" Property="Opacity" Value="0.55"/>
       </Trigger>
       <Trigger Property="IsEnabled" Value="False">
        <Setter TargetName="Surface" Property="Opacity" Value="0.35"/>
       </Trigger>
      </ControlTemplate.Triggers>
     </ControlTemplate>
    </Setter.Value>
   </Setter>
  </Style>
 </Window.Resources>
 <Border Margin="16" Background="#141E1B" BorderBrush="#34483F" BorderThickness="1" CornerRadius="22">
  <Border.Effect><DropShadowEffect BlurRadius="24" ShadowDepth="5" Opacity="0.35"/></Border.Effect>
  <Grid Margin="28,22,28,24">
   <Grid.RowDefinitions>
    <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
    <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
   </Grid.RowDefinitions>
   <Grid x:Name="Header" Background="Transparent" Margin="0,0,0,20">
    <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
    <StackPanel>
     <TextBlock Text="VCP / HUMAN REPLY" FontSize="10" FontWeight="SemiBold"
                Foreground="#86E5BA" Margin="0,0,0,7"/>
     <TextBlock x:Name="Heading" FontSize="21" FontWeight="SemiBold"
                TextTrimming="CharacterEllipsis"/>
    </StackPanel>
    <Button x:Name="CloseButton" Grid.Column="1" Content="×" FontSize="21"
            Padding="10,2" Background="Transparent" BorderThickness="0"
            VerticalAlignment="Top" ToolTip="取消回复（Esc）"
            AutomationProperties.Name="取消回复"/>
   </Grid>
   <ScrollViewer x:Name="BodyScroll" Grid.Row="1" VerticalScrollBarVisibility="Auto"
                 HorizontalScrollBarVisibility="Disabled" Margin="0,0,0,18">
    <StackPanel>
     <TextBlock x:Name="PromptText" TextWrapping="Wrap" FontSize="15"
                LineHeight="25" Foreground="#D5E1DC" Margin="0,0,0,16"/>
     <StackPanel x:Name="OptionsPanel"/>
    </StackPanel>
   </ScrollViewer>
   <Border Grid.Row="2" Background="#0D1613" BorderBrush="#35483F"
           BorderThickness="1" CornerRadius="12" Padding="14,12">
    <Grid>
     <TextBox x:Name="ReplyText" MinHeight="72" MaxHeight="160"
              Background="Transparent" Foreground="#EDF3F1" CaretBrush="#86E5BA"
              BorderThickness="0" TextWrapping="Wrap" AcceptsReturn="True"
              VerticalScrollBarVisibility="Auto" FontSize="15"
              AutomationProperties.Name="输入回复"/>
     <TextBlock x:Name="InputHint" Text="直接说说你的想法…" Foreground="#627B6F"
                IsHitTestVisible="False" Margin="2,2,0,0"/>
    </Grid>
   </Border>
   <Grid Grid.Row="3" Margin="0,18,0,0">
    <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
    <StackPanel VerticalAlignment="Center">
     <TextBlock Text="Enter 发送 · Shift+Enter 换行" FontSize="11" Foreground="#8AA297"/>
     <TextBlock x:Name="Countdown" FontSize="11" Foreground="#627B6F" Margin="0,5,0,0"/>
    </StackPanel>
    <StackPanel Grid.Column="1" Orientation="Horizontal">
     <Button x:Name="DisableButton" Content="不再询问" Background="Transparent"
             BorderThickness="0" Padding="10,10" Margin="0,0,10,0"
             ToolTip="通知 AI 本次对话不再使用此工具"/>
     <Button x:Name="SendButton" Content="发送回复  ↗" Background="#86E5BA"
             Foreground="#10251A" BorderBrush="#86E5BA" FontWeight="SemiBold"/>
    </StackPanel>
   </Grid>
  </Grid>
 </Border>
</Window>
'@
    # Colors only: never interpolate user text or execute theme content.
    if ($null -ne $data.theme) {
        $allowed = @('#141E1B', '#202D29', '#0D1613', '#EDF3F1', '#D5E1DC',
                     '#B7C7C2', '#8AA297', '#627B6F', '#35483F', '#34483F',
                     '#86E5BA', '#10251A')
        $palette = @{}
        foreach ($entry in $data.theme.PSObject.Properties) {
            if ($allowed -ccontains $entry.Name -and
                [string]$entry.Value -cmatch '^#[0-9A-Fa-f]{6}$') {
                $palette[$entry.Name] = [string]$entry.Value
            }
        }
        # Single pass avoids replacing one newly mapped color a second time.
        $xamlText = [regex]::Replace($xamlText, '#[0-9A-Fa-f]{6}', {
            param($match)
            if ($palette.ContainsKey($match.Value)) { $palette[$match.Value] }
            else { $match.Value }
        })
    }
    [xml]$xaml = $xamlText
    $reader = New-Object System.Xml.XmlNodeReader $xaml
    $window = [Windows.Markup.XamlReader]::Load($reader)
    $heading = $window.FindName('Heading')
    $reply = $window.FindName('ReplyText')
    $hint = $window.FindName('InputHint')
    $send = $window.FindName('SendButton')
    $countdown = $window.FindName('Countdown')
    $panel = $window.FindName('OptionsPanel')
    $window.Title = [string]$data.title
    $heading.Text = [string]$data.title
    $window.FindName('PromptText').Text = [string]$data.prompt
    $reply.Text = [string]$data.placeholder
    $workArea = [Windows.SystemParameters]::WorkArea
    $window.Width = [Math]::Min(620, $workArea.Width - 24)
    $window.MaxHeight = $workArea.Height - 24
    $window.FindName('BodyScroll').MaxHeight = [Math]::Max(80, $workArea.Height - 370)
    $script:outcome = @{ kind = 'cancel'; text = '' }
    $script:finished = $false
    $finish = {
        param([string]$kind, [string]$text)
        if ($script:finished) { return }
        $script:finished = $true
        $script:outcome = @{ kind = $kind; text = $text }
        $window.Close()
    }
    $submit = {
        if (-not [string]::IsNullOrWhiteSpace($reply.Text)) {
            & $finish 'text' $reply.Text
        }
    }
    $updateInput = {
        $empty = [string]::IsNullOrEmpty($reply.Text)
        $hint.Visibility = if ($empty) { 'Visible' } else { 'Collapsed' }
        $send.IsEnabled = -not [string]::IsNullOrWhiteSpace($reply.Text)
    }
    $reply.Add_TextChanged($updateInput)
    & $updateInput
    $options = @($data.options)
    for ($i = 0; $i -lt $options.Count; $i++) {
        $button = New-Object Windows.Controls.Button
        $button.HorizontalContentAlignment = 'Left'
        $button.Margin = '0,0,0,8'
        $button.Tag = [string]$options[$i][1]
        $button.ToolTip = "Alt+$($i + 1)"
        $label = New-Object Windows.Controls.TextBlock
        $label.Text = "$($i + 1)   $($options[$i][1])"
        $label.TextWrapping = 'Wrap'
        $button.Content = $label
        $button.Add_Click({ param($sender, $eventArgs) & $finish 'option' ([string]$sender.Tag) })
        [void]$panel.Children.Add($button)
    }
    $window.FindName('Header').Add_MouseLeftButtonDown({
        param($sender, $eventArgs)
        if ($eventArgs.OriginalSource -is [Windows.Controls.TextBlock] -or
            $eventArgs.OriginalSource -eq $sender) { $window.DragMove() }
    })
    $window.FindName('CloseButton').Add_Click({ & $finish 'cancel' '' })
    $window.FindName('DisableButton').Add_Click({ & $finish 'disable' '' })
    $send.Add_Click($submit)
    # IME composition reports ImeProcessed, not Return; Shift+Enter stays with TextBox.
    $window.Add_PreviewKeyDown({
        param($sender, $eventArgs)
        if ($eventArgs.Key -eq [Windows.Input.Key]::Escape) {
            $eventArgs.Handled = $true
            & $finish 'cancel' ''
        } elseif ($eventArgs.Key -eq [Windows.Input.Key]::Return -and
                  [Windows.Input.Keyboard]::Modifiers -eq [Windows.Input.ModifierKeys]::None -and
                  $eventArgs.OriginalSource -eq $reply) {
            $eventArgs.Handled = $true
            & $submit
        } elseif ($eventArgs.Key -eq [Windows.Input.Key]::System -and
                  [Windows.Input.Keyboard]::Modifiers -eq [Windows.Input.ModifierKeys]::Alt) {
            $index = [int]$eventArgs.SystemKey - [int][Windows.Input.Key]::D1
            if ($index -ge 0 -and $index -lt $options.Count) {
                $eventArgs.Handled = $true
                & $finish 'option' ([string]$options[$index][1])
            }
        }
    })
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $timer = New-Object Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(250)
    $tick = {
        $remaining = [Math]::Max(0, [Math]::Ceiling([double]$data.timeout - $clock.Elapsed.TotalSeconds))
        $countdown.Text = "等待回复 · 剩余 $([int][Math]::Floor($remaining / 60)):$(([int]($remaining % 60)).ToString('00'))"
        if ($remaining -le 0) { & $finish 'cancel' '' }
    }
    $timer.Add_Tick($tick)
    # One-shot foreground pulse, not a permanently topmost dialog.
    $foregroundTimer = New-Object Windows.Threading.DispatcherTimer
    $foregroundTimer.Interval = [TimeSpan]::FromMilliseconds(200)
    $foregroundTimer.Add_Tick({
        $foregroundTimer.Stop()
        $window.Topmost = $false
    })
    $script:foregroundRaised = $false
    $window.Add_ContentRendered({
        if (-not $script:foregroundRaised) {
            $script:foregroundRaised = $true
            $window.Topmost = $true
            [void]$window.Activate()
            $foregroundTimer.Start()
        }
        [void]$reply.Focus()
        $reply.SelectAll()
        & $tick
        if (-not $script:finished) { $timer.Start() }
    })
    $window.Add_Closed({ $foregroundTimer.Stop(); $timer.Stop(); $clock.Stop() })
    [void]$window.ShowDialog()
    [Console]::Out.WriteLine(($script:outcome | ConvertTo-Json -Compress))
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}