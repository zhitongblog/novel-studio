fn main() {
    println!("cargo:rerun-if-changed=../../ui");
    println!("cargo:rerun-if-changed=../../ui/index.html");
    println!("cargo:rerun-if-changed=../../ui/app.js");
    println!("cargo:rerun-if-changed=../../ui/style.css");
    println!("cargo:rerun-if-changed=../../src");
    println!("cargo:rerun-if-changed=../../bin");
    tauri_build::build()
}
