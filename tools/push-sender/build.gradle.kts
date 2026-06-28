plugins {
    kotlin("jvm") version "2.4.0"
    application
}

repositories {
    mavenLocal()
    mavenCentral()
    google()
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

dependencies {
    implementation("com.obscura:obscura-kit:0.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    implementation("org.json:json:20260522")
    runtimeOnly("org.slf4j:slf4j-simple:2.0.18")
}

application {
    mainClass.set("MainKt")
}
