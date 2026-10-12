//go:build windows

// NexusSetup.exe: Nexus 설치 프로그램. 설치할 폴더를 묻고 Node.js와 git 설치, GitHub에서 받기,
// 빌드, 바탕 화면 바로 가기까지 한다. 화면과 실제 일은 함께 들어 있는 setup.ps1(PowerShell)이 한다.
package main

import (
	"bytes"
	_ "embed"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"unsafe"
)

//go:embed setup.ps1
var script []byte

const createNoWindow = 0x08000000

func fail(text string) {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString("Nexus 설치")
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x10)
	os.Exit(1)
}

func main() {
	file := filepath.Join(os.TempDir(), "nexus-setup-"+strconv.Itoa(os.Getpid())+".ps1")
	if err := os.WriteFile(file, script, 0o600); err != nil {
		fail("설치 파일을 준비하지 못했어요: " + err.Error())
	}
	defer os.Remove(file)

	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(ps); err != nil {
		ps = "powershell.exe"
	}
	cmd := exec.Command(ps, "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", file)
	// HideWindow(SW_HIDE)는 쓰지 않는다: 그 값이 PowerShell이 처음 띄우는 창(설치 화면, 켜는 중 화면)에도
	// 적용돼 창이 보이지 않게 된다. 콘솔은 CREATE_NO_WINDOW로 이미 없다.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		// 화면이 뜨기 전에 멈췄으면 이유를 보여 준다(아무 반응 없이 끝나지 않게).
		msg := out.String()
		if len(msg) > 1500 {
			msg = msg[len(msg)-1500:]
		}
		if _, ok := err.(*exec.ExitError); !ok {
			fail("설치 프로그램을 켜지 못했어요: " + err.Error())
		}
		fail("설치 프로그램이 멈췄어요.\n\n" + msg)
	}
}
