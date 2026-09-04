fn main() {
    println!("cargo:rerun-if-changed=../assets/iconset/VChatOfficial/vchat_main.ico");

    #[cfg(windows)]
    {
        let mut resource = winres::WindowsResource::new();
        resource.set_icon("../assets/iconset/VChatOfficial/vchat_main.ico");
        resource
            .compile()
            .expect("无法将 VChat 官方图标嵌入 Windows 可执行文件");
    }
}