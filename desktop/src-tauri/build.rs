fn main() {
    println!("cargo:rerun-if-changed=../../ui");
    println!("cargo:rerun-if-changed=../../src");
    println!("cargo:rerun-if-changed=../../bin");
    tauri_build::build()
}
