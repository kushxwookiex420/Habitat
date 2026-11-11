plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.habitat"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        targetSdk = 35
        versionCode = 85
        versionName = "0.8.5"
    }

    flavorDimensions += "edition"
    productFlavors {
        create("regular") {
            dimension = "edition"
            applicationId = "com.habitat"
            manifestPlaceholders["appLabel"] = "Habitat"
        }
        create("bridge") {
            dimension = "edition"
            applicationId = "com.habitat.axbridge"
            manifestPlaceholders["appLabel"] = "Habitat AX Bridge"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

kotlin { jvmToolchain(17) }
