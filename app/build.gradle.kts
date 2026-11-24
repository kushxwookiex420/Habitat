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
        versionCode = 86
        versionName = "0.8.6"
    }
    buildFeatures {
        buildConfig = true
    }
    flavorDimensions += "environment"
    productFlavors {
        create("production") {
            dimension = "environment"
            buildConfigField("String", "HABITAT_API_BASE_URL", "\"https://habitat-1-szzd.onrender.com\"")
        }
        create("staging") {
            dimension = "environment"
            applicationIdSuffix = ".staging"
            versionNameSuffix = "-staging"
            buildConfigField("String", "HABITAT_API_BASE_URL", "\"https://habitat-staging-e3ie.onrender.com\"")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // Release signing is supplied by the owner's environment at build time and is never committed.
    // With no variables present the release build still compiles, but it is unsigned and must not be
    // installed as an update; the build script refuses that case explicitly.
    signingConfigs {
        // One debug identity, owned by the repository, so a build from any machine or CI run can
        // replace another one. `android`/`androiddebugkey` is the public debug credential, not a
        // secret, and this config is referenced only by the debug build type — never by release.
        create("repositoryDebug") {
            storeFile = rootProject.file("debug-key.p12")
            storeType = "PKCS12"
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        create("owner") {
            val storePath = System.getenv("HABITAT_KEYSTORE_FILE")
            val storePasswordValue = System.getenv("HABITAT_KEYSTORE_PASSWORD")
            val aliasValue = System.getenv("HABITAT_KEY_ALIAS")
            val keyPasswordValue = System.getenv("HABITAT_KEY_PASSWORD")
            if (!storePath.isNullOrBlank() && !storePasswordValue.isNullOrBlank() &&
                !aliasValue.isNullOrBlank() && !keyPasswordValue.isNullOrBlank()) {
                storeFile = file(storePath)
                storePassword = storePasswordValue
                keyAlias = aliasValue
                keyPassword = keyPasswordValue
            }
        }
    }
    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("repositoryDebug")
        }
        release {
            isMinifyEnabled = false
            val signingReady = listOf(
                "HABITAT_KEYSTORE_FILE", "HABITAT_KEYSTORE_PASSWORD",
                "HABITAT_KEY_ALIAS", "HABITAT_KEY_PASSWORD"
            ).all { !System.getenv(it).isNullOrBlank() }
            if (signingReady) signingConfig = signingConfigs.getByName("owner")
        }
    }
}
kotlin { jvmToolchain(17) }
