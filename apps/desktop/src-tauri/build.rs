fn main() {
    // 生成 gen/schemas/*.json（能力声明的 schema）并校验 tauri.conf.json。
    // 这里不跑任何自定义代码：外壳越薄越好。
    tauri_build::build()
}
