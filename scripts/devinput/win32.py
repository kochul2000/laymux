"""Raw Win32 bindings for the dev-input helper (ctypes only, no deps).

Everything here is a thin, side-effect-free wrapper. Policy (who may be
typed into, when to abort) lives in `guard.py` — never here.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

ULONG_PTR = wintypes.WPARAM
LRESULT = ctypes.c_ssize_t

# -- SendInput --------------------------------------------------------------

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008

MAPVK_VK_TO_VSC = 0

# Tag our own injections so we can recognise them in the low-level hooks even
# on Windows builds that under-report LLKHF_INJECTED.
DEVINPUT_SIGNATURE = 0x1A4D5558  # b"\x1aMUX"


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT
user32.MapVirtualKeyW.argtypes = (wintypes.UINT, wintypes.UINT)
user32.MapVirtualKeyW.restype = wintypes.UINT


def send_inputs(inputs: list[INPUT]) -> int:
    """Push events onto the OS input queue. Returns how many were accepted."""
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    sent = user32.SendInput(n, arr, ctypes.sizeof(INPUT))
    if sent != n:
        raise OSError(
            ctypes.get_last_error(),
            f"SendInput accepted {sent}/{n} events "
            "(UIPI block? target running elevated?)",
        )
    return sent


def key_input(vk: int, *, up: bool, extended: bool) -> INPUT:
    """One keyboard event, scancode-based so the DOM sees a correct `code`."""
    scan = user32.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)
    flags = KEYEVENTF_SCANCODE
    if up:
        flags |= KEYEVENTF_KEYUP
    if extended:
        flags |= KEYEVENTF_EXTENDEDKEY
    ev = INPUT(type=INPUT_KEYBOARD)
    # wVk must stay set too: xterm/WebView2 read the VK, the scancode drives `code`.
    ev.ki = KEYBDINPUT(
        wVk=vk, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=DEVINPUT_SIGNATURE
    )
    return ev


def unicode_input(code_unit: int, *, up: bool) -> INPUT:
    """A UTF-16 code unit delivered as WM_CHAR. Bypasses the IME entirely."""
    flags = KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if up else 0)
    ev = INPUT(type=INPUT_KEYBOARD)
    ev.ki = KEYBDINPUT(
        wVk=0, wScan=code_unit, dwFlags=flags, time=0, dwExtraInfo=DEVINPUT_SIGNATURE
    )
    return ev


# -- Window / process queries ----------------------------------------------

user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
user32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
user32.IsWindowVisible.argtypes = (wintypes.HWND,)
user32.GetAsyncKeyState.argtypes = (ctypes.c_int,)
user32.GetAsyncKeyState.restype = ctypes.c_short

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = (WNDENUMPROC, wintypes.LPARAM)


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


user32.GetWindowRect.argtypes = (wintypes.HWND, ctypes.POINTER(RECT))


kernel32.QueryFullProcessImageNameW.argtypes = (
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
)
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL


def process_image_path(pid: int) -> str:
    """Full exe path for `pid`, or "" if it cannot be queried."""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION, False, wintypes.DWORD(pid)
    )
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return ""
        return buf.value
    finally:
        kernel32.CloseHandle(handle)


def foreground_window() -> int:
    return user32.GetForegroundWindow() or 0


def window_pid(hwnd: int) -> int:
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
    return pid.value


def window_thread(hwnd: int) -> int:
    pid = wintypes.DWORD(0)
    return user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))


def window_title(hwnd: int) -> str:
    length = user32.GetWindowTextLengthW(wintypes.HWND(hwnd))
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(wintypes.HWND(hwnd), buf, length + 1)
    return buf.value


def top_level_windows_of(pid: int) -> list[int]:
    """Visible, non-zero-area top-level windows owned by `pid`, biggest first."""
    found: list[tuple[int, int]] = []

    def _cb(hwnd, _lparam):
        if window_pid(hwnd) == pid and user32.IsWindowVisible(wintypes.HWND(hwnd)):
            rect = RECT()
            user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect))
            area = max(0, rect.right - rect.left) * max(0, rect.bottom - rect.top)
            if area > 0:
                found.append((area, hwnd))
        return True

    user32.EnumWindows(WNDENUMPROC(_cb), 0)
    found.sort(reverse=True)
    return [hwnd for _area, hwnd in found]


# -- Foreground handoff -----------------------------------------------------

SW_MINIMIZE = 6
SW_RESTORE = 9

kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
kernel32.GetExitCodeProcess.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
kernel32.CloseHandle.restype = wintypes.BOOL

user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
user32.AttachThreadInput.argtypes = (wintypes.DWORD, wintypes.DWORD, wintypes.BOOL)
user32.BringWindowToTop.argtypes = (wintypes.HWND,)
kernel32.GetCurrentThreadId.restype = wintypes.DWORD


def force_foreground(hwnd: int) -> bool:
    """Best-effort foreground steal for a window we are allowed to target.

    Windows blocks SetForegroundWindow from background processes, so escalate:
    plain call -> AttachThreadInput to the current foreground thread ->
    minimize/restore. Returns whether `hwnd` actually ended up foreground.
    """
    handle = wintypes.HWND(hwnd)
    user32.SetForegroundWindow(handle)
    if foreground_window() == hwnd:
        return True

    fg_thread = window_thread(foreground_window())
    own_thread = kernel32.GetCurrentThreadId()
    if fg_thread and user32.AttachThreadInput(own_thread, fg_thread, True):
        try:
            user32.BringWindowToTop(handle)
            user32.SetForegroundWindow(handle)
        finally:
            user32.AttachThreadInput(own_thread, fg_thread, False)
    if foreground_window() == hwnd:
        return True

    user32.ShowWindow(handle, SW_MINIMIZE)
    user32.ShowWindow(handle, SW_RESTORE)
    return foreground_window() == hwnd


# -- Low-level input hooks (dead-man switch) --------------------------------

WH_KEYBOARD_LL = 13
WH_MOUSE_LL = 14
WM_QUIT = 0x0012
WM_KEYDOWN = 0x0100
WM_SYSKEYDOWN = 0x0104
WM_MOUSEMOVE = 0x0200

LLKHF_INJECTED = 0x10
LLMHF_INJECTED = 0x01

HOOKPROC = ctypes.WINFUNCTYPE(LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

user32.SetWindowsHookExW.argtypes = (
    ctypes.c_int,
    HOOKPROC,
    wintypes.HINSTANCE,
    wintypes.DWORD,
)
user32.SetWindowsHookExW.restype = wintypes.HHOOK
user32.CallNextHookEx.argtypes = (
    wintypes.HHOOK,
    ctypes.c_int,
    wintypes.WPARAM,
    wintypes.LPARAM,
)
user32.CallNextHookEx.restype = LRESULT
user32.UnhookWindowsHookEx.argtypes = (wintypes.HHOOK,)
user32.GetMessageW.argtypes = (
    ctypes.POINTER(wintypes.MSG),
    wintypes.HWND,
    wintypes.UINT,
    wintypes.UINT,
)
user32.PostThreadMessageW.argtypes = (
    wintypes.DWORD,
    wintypes.UINT,
    wintypes.WPARAM,
    wintypes.LPARAM,
)


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("pt", wintypes.POINT),
        ("mouseData", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


# -- Virtual key names ------------------------------------------------------

VK_SHIFT = 0x10
VK_CONTROL = 0x11
VK_MENU = 0x12
VK_LWIN = 0x5B
VK_RWIN = 0x5C
VK_HANGUL = 0x15
VK_BACK = 0x08

MODIFIER_VKS = (VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN)

# Keys whose scancode must carry KEYEVENTF_EXTENDEDKEY.
EXTENDED_VKS = frozenset(
    {
        0x21,  # pgup
        0x22,  # pgdn
        0x23,  # end
        0x24,  # home
        0x25,  # left
        0x26,  # up
        0x27,  # right
        0x28,  # down
        0x2D,  # insert
        0x2E,  # delete
        0x5B,  # lwin
        0x5C,  # rwin
        0x90,  # numlock
        0xA3,  # rcontrol
        0xA5,  # ralt
    }
)

NAMED_VKS: dict[str, int] = {
    "backspace": VK_BACK,
    "bs": VK_BACK,
    "tab": 0x09,
    "enter": 0x0D,
    "return": 0x0D,
    "shift": VK_SHIFT,
    "ctrl": VK_CONTROL,
    "control": VK_CONTROL,
    "alt": VK_MENU,
    "win": VK_LWIN,
    "meta": VK_LWIN,
    "hangul": VK_HANGUL,
    "hanja": 0x19,
    "esc": 0x1B,
    "escape": 0x1B,
    "space": 0x20,
    "pgup": 0x21,
    "pgdn": 0x22,
    "end": 0x23,
    "home": 0x24,
    "left": 0x25,
    "up": 0x26,
    "right": 0x27,
    "down": 0x28,
    "insert": 0x2D,
    "delete": 0x2E,
    "del": 0x2E,
    "lctrl": 0xA2,
    "rctrl": 0xA3,
    "lalt": 0xA4,
    "ralt": 0xA5,
    "lshift": 0xA0,
    "rshift": 0xA1,
}
for _i in range(1, 13):
    NAMED_VKS[f"f{_i}"] = 0x70 + _i - 1


def vk_for(name: str) -> int:
    """Resolve a key name ('a', '4', 'enter', 'f5') to a virtual key code."""
    key = name.strip().lower()
    if key in NAMED_VKS:
        return NAMED_VKS[key]
    if len(key) == 1:
        if "a" <= key <= "z":
            return ord(key.upper())
        if "0" <= key <= "9":
            return ord(key)
    raise ValueError(f"unknown key name: {name!r}")


def modifier_held_physically() -> list[str]:
    """Modifiers currently down according to the OS (ours or the user's)."""
    names = {VK_CONTROL: "ctrl", VK_MENU: "alt", VK_SHIFT: "shift", VK_LWIN: "win"}
    return [n for vk, n in names.items() if user32.GetAsyncKeyState(vk) & 0x8000]
