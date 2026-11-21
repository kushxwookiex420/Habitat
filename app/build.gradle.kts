plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Production is the default. A nonproduction build must pass -PhabitatBaseUrl=<url> explicitly;
// nothing in the debug or release build silently points at a non-default backend.
val habitatBaseUrl = (project.findProperty("habitatBaseUrl") as String?)
    ?.trim()
    ?.trimEnd('/')
    ?.takeIf { it.isNotEmpty() }
    ?: "https://habitat-1-szzd.onrender.com"

android {
    namespace = "com.habitat"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.habitat.axbridge"
        minSdk = 26
        targetSdk = 35
        versionCode = 85
        versionName = "0.8.5"
        buildConfigField("String", "HABITAT_BASE_URL", "\"$habitatBaseUrl\"")
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }
    buildFeatures { buildConfig = true }
    buildTypes {
        debug {
            // Debug builds only: allows a loopback nonproduction service over plain HTTP.
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }
}
kotlin { jvmToolchain(17) }

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
}
