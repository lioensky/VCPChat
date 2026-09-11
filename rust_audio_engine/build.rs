fn main() {
    // The Rubato experiment is fully pure Rust. Keep a build script only as a
    // stable Cargo entry point; no native resampler discovery or linking occurs.
    println!("cargo:rerun-if-changed=build.rs");
}
