using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace TokenTrackerWin;

/// <summary>A resident quota surface; the tray owns polling and its lifetime.</summary>
internal sealed class QuotaWidgetWindow : Window
{
    private readonly ServerManager _server;
    private readonly WebView2CompositionControl _view = new() { AllowExternalDrop = false };
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(2) };
    private readonly Action _openDashboard;
    private readonly QuotaWidgetSettings _settings;
    private JsonNode? _limits;
    private bool _failed;
    private bool _ready;
    private bool _closed;
    private bool _expanded;
    private bool _placed;
    private string? _lastContext;
    private nint _hwnd;
    private (int Width, int Height, int Radius) _regionSize;

    public bool Enabled => _settings.Enabled;
    public event Action? EnabledChanged;

    public QuotaWidgetWindow(ServerManager server, Action openDashboard)
    {
        _server = server;
        _openDashboard = openDashboard;
        _settings = QuotaWidgetSettings.Load();
        Title = Constants.AppDisplayName;
        Width = 320;
        Height = 144;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = System.Windows.Media.Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        Content = _view;
        SourceInitialized += (_, _) =>
        {
            _hwnd = new WindowInteropHelper(this).Handle;
            // Tool window: excluded from Alt+Tab. Do not add WS_EX_NOACTIVATE;
            // explicit clicks must still allow keyboard interaction with controls.
            SetWindowLongPtr(_hwnd, -20, GetWindowLongPtr(_hwnd, -20) | 0x80);
            HwndSource.FromHwnd(_hwnd)?.AddHook(WindowMessage);
        };
        Loaded += async (_, _) =>
        {
            if (!_placed) { Place(true); _placed = true; }
            try { await InitializeAsync(); }
            catch (Exception ex)
            {
                if (_closed) return;
                Diag.Log("quota", $"initialization failed: {ex.Message}");
                // Keep an actionable native fallback if WebView2 is unavailable.
                var retry = new System.Windows.Controls.Button { Content = QuotaMenuText() };
                retry.Click += (_, _) => _openDashboard();
                Content = retry;
            }
        };
        _server.StatusChanged += ServerChanged;
        _timer.Tick += (_, _) =>
        {
            if (_closed || !_settings.Enabled) return;
            if (ForegroundIsFullscreen()) { if (IsVisible) Hide(); }
            else if (!IsVisible) Show();
            if (IsVisible) Place(false);
            PushContext();
        };
        _timer.Start();
        Closing += (_, e) =>
        {
            if (_closed) return;
            e.Cancel = true;
            SetEnabled(false);
        };
    }

    public static string QuotaMenuText() => NativeLocalization.CurrentResolvedLocale switch
    {
        NativeLocalization.ChineseLocale => "桌面限额",
        NativeLocalization.TraditionalChineseLocale => "桌面限額",
        "ja" => "デスクトップ使用枠",
        "ko" => "데스크톱 사용 한도",
        "de" => "Desktop-Kontingent",
        _ => "Desktop quota",
    };

    public void SetEnabled(bool enabled)
    {
        _settings.Enabled = enabled;
        _settings.Save();
        if (enabled) { Show(); Place(false); }
        else Hide();
        EnabledChanged?.Invoke();
    }

    public void ApplyLimits(string json)
    {
        try { _limits = JsonNode.Parse(json); _failed = false; }
        catch (JsonException) { _failed = true; }
        PushContext();
    }

    public void MarkFailed() { _failed = true; PushContext(); }

    private async Task InitializeAsync()
    {
        if (_view.CoreWebView2 is not null || _closed) return;
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TokenTracker", "WebView2Quota");
        var environment = await CoreWebView2Environment.CreateAsync(null, folder);
        if (_closed) return;
        await _view.EnsureCoreWebView2Async(environment);
        if (_closed) return;
        _view.DefaultBackgroundColor = System.Drawing.Color.Transparent;
        var core = _view.CoreWebView2 ?? throw new InvalidOperationException("WebView2 initialization did not create a core.");
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.NavigationStarting += (_, e) =>
        {
            if (!AllowedSource(e.Uri)) e.Cancel = true;
            _ready = false;
        };
        core.WebMessageReceived += ReceiveMessage;
        core.ProcessFailed += (_, _) => { _ready = false; _failed = true; };
        Navigate();
    }

    private bool AllowedSource(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && Uri.TryCreate(_server.BaseUrl, UriKind.Absolute, out var server)
        && uri.Scheme == server.Scheme && uri.Authority == server.Authority && uri.AbsolutePath == "/quota.html";

    private void ReceiveMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!AllowedSource(e.Source) || _closed) return;
        string message;
        try { message = e.TryGetWebMessageAsString(); }
        catch (ArgumentException) { return; }
        switch (message)
        {
            case "quota:ready": _ready = true; _lastContext = null; PushContext(); break;
            case "quota:expand": ResizeWidget(true); break;
            case "quota:collapse": ResizeWidget(false); break;
            case "quota:dashboard": _openDashboard(); break;
            case "quota:drag":
                ReleaseCapture();
                SendMessage(_hwnd, 0xA1, (nint)2, 0);
                Place(false);
                if (GetWindowRect(_hwnd, out var rect)) { _settings.X = rect.Left; _settings.Y = rect.Top; _settings.Save(); }
                break;
            default:
                if (message.Length > 1024) return;
                try
                {
                    using var doc = JsonDocument.Parse(message);
                    var root = doc.RootElement;
                    if (root.GetProperty("type").GetString() != "quota:select") return;
                    var ids = root.GetProperty("ids").EnumerateArray().Select(value => value.GetString()).ToArray();
                    if (ids.Length > 2 || ids.Any(id => string.IsNullOrEmpty(id) || id.Length > 100)) return;
                    _settings.Selected = ids.Select(id => id!).Distinct().ToArray();
                    _settings.Save();
                    PushContext();
                }
                catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException) { }
                break;
        }
    }

    private void ResizeWidget(bool expanded)
    {
        _expanded = expanded;
        Width = expanded ? 360 : 320;
        Height = expanded ? 340 : 144;
        Place(false);
    }

    private void ServerChanged(ServerManager.ServerStatus status)
    {
        if (_closed) return;
        Dispatcher.BeginInvoke(new Action(() =>
        {
            if (_closed) return;
            if (status == ServerManager.ServerStatus.Running) Navigate();
            else MarkFailed();
        }));
    }

    private void Navigate()
    {
        if (!_closed && _view.CoreWebView2 is not null && _server.Status == ServerManager.ServerStatus.Running)
            _view.CoreWebView2.Navigate(_server.BaseUrl + "/quota.html?app=1");
    }

    private void PushContext()
    {
        if (!_ready || _closed) return;
        var json = JsonSerializer.Serialize(new
        {
            type = "quota:context", limits = _limits, failed = _failed,
            selected = _settings.Selected,
            locale = NativeLocalization.CurrentResolvedLocale,
            light = NativeTheme.ResolveIsLight(NativeTheme.CurrentPreference),
        });
        if (json == _lastContext) return;
        try { _view.CoreWebView2.PostWebMessageAsJson(json); _lastContext = json; }
        catch (InvalidOperationException) { _ready = false; }
    }

    private void Place(bool restore)
    {
        if (_hwnd == 0) return;
        var scale = GetDpiForWindow(_hwnd) / 96d;
        var width = (int)Math.Round(Width * scale);
        var height = (int)Math.Round(Height * scale);
        GetWindowRect(_hwnd, out var rect);
        var x = restore ? _settings.X : rect.Left;
        var y = restore ? _settings.Y : rect.Top;
        var screen = x.HasValue && y.HasValue ? Screen.FromPoint(new System.Drawing.Point(x.Value, y.Value)) : Screen.PrimaryScreen!;
        var work = screen.WorkingArea;
        var left = Math.Clamp(x ?? work.Right - width - 16, work.Left, Math.Max(work.Left, work.Right - width));
        var top = Math.Clamp(y ?? work.Top + work.Height / 3, work.Top, Math.Max(work.Top, work.Bottom - height));
        if (rect.Left != left || rect.Top != top || rect.Right - rect.Left != width || rect.Bottom - rect.Top != height)
            SetWindowPos(_hwnd, 0, left, top, width, height, 0x14); // NOZORDER | NOACTIVATE
        var radius = (int)((_expanded ? 20 : 18) * scale * 2);
        if (_regionSize != (width, height, radius))
        {
            var region = CreateRoundRectRgn(0, 0, width + 1, height + 1, radius, radius);
            if (SetWindowRgn(_hwnd, region, true) == 0) DeleteObject(region);
            else _regionSize = (width, height, radius);
        }
    }

    private nint WindowMessage(nint hwnd, int message, nint wParam, nint lParam, ref bool handled)
    {
        if (message is 0x02E0 or 0x007E) Dispatcher.BeginInvoke(new Action(() => { if (!_closed) Place(false); }));
        return 0;
    }

    private bool ForegroundIsFullscreen()
    {
        var foreground = GetForegroundWindow();
        if (foreground == 0 || foreground == _hwnd || !GetWindowRect(foreground, out var rect)) return false;
        var className = new System.Text.StringBuilder(256);
        GetClassName(foreground, className, className.Capacity);
        if (className.ToString() is "Progman" or "WorkerW") return false;
        var screen = Screen.FromHandle(_hwnd);
        var bounds = screen.Bounds;
        return rect.Left <= bounds.Left && rect.Top <= bounds.Top && rect.Right >= bounds.Right && rect.Bottom >= bounds.Bottom;
    }

    public void Shutdown()
    {
        if (_closed) return;
        _closed = true;
        _timer.Stop();
        _server.StatusChanged -= ServerChanged;
        _view.Dispose();
        Close();
    }

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(nint hwnd, System.Text.StringBuilder value, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern nint GetWindowLongPtr(nint hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern nint SetWindowLongPtr(nint hwnd, int index, nint value);
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern nint SendMessage(nint hwnd, int message, nint wParam, nint lParam);
    [DllImport("gdi32.dll")] private static extern nint CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(nint hwnd, nint region, bool redraw);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(nint obj);
}
