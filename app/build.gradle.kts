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
        versionCode = 33
        versionName = "0.3.3"
    }
}
