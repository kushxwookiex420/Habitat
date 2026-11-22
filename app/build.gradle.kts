plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.habitat"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.habitat.axbridge"
        minSdk = 26
        targetSdk = 35
        versionCode = 85
        versionName = "0.8.5"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
kotlin { jvmToolchain(17) }

dependencies {
    testImplementation("junit:junit:4.13.2")
}
