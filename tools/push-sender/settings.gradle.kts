rootProject.name = "push-sender"

// ── obscura-native Kotlin composite build ───────────────────────────
// Mirrors android/settings.gradle: compose the pinned submodule's Gradle build
// rather than resolve a published artifact. The old mavenLocal workflow
// (`publishToMavenLocal` in the kit, then build here) silently resolved
// whatever jar happened to be in ~/.m2, which drifted two months behind the
// kit and hid API breaks until runtime.
//
// `implementation("com.obscura:obscura-kit:0.1.0")` in build.gradle.kts stays
// as-is; the substitution below rewrites it to the local :lib project. It must
// be explicit: the kit sets `groupId` only inside its `publishing` block, so
// Gradle's automatic coordinate matching does NOT fire, and an `includeBuild`
// without this block quietly falls back to mavenLocal.
//
// OBSCURA_KIT_PATH can point at another checkout while developing coordinated
// native changes.
val obscuraKitPath = System.getenv("OBSCURA_KIT_PATH") ?: "../../obscura-native/kotlin"
includeBuild(obscuraKitPath) {
    dependencySubstitution {
        substitute(module("com.obscura:obscura-kit")).using(project(":lib"))
    }
}
