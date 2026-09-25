plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.habitat"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.habitat"
        minSdk = 26
        targetSdk = 35
        versionCode = 50
        versionName = "0.5.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
kotlin { jvmToolchain(17) }
