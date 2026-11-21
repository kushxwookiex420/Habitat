import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Two build flavors, one environment each.
//
// production: the endpoint below is compiled in and can never be overridden. A stray
// -PhabitatBaseUrl cannot repoint a production artifact.
//
// nonproduction: -PhabitatBaseUrl is required. The build fails without it, and fails when it names
// the production host, so there is no silent production fallback in an APK that is labeled
// nonproduction. The URL is also re-checked by HabitatEndpointPolicy at runtime.
val productionBaseUrl = "https://habitat-1-szzd.onrender.com"
val productionHost = "habitat-1-szzd.onrender.com"
val requestedBaseUrl = (project.findProperty("habitatBaseUrl") as String?)
    ?.trim()
    ?.trimEnd('/')
    ?.takeIf { it.isNotEmpty() }

val nonProductionRequested = gradle.startParameter.taskNames.any {
    it.contains("nonproduction", ignoreCase = true) || it.contains("nonprod", ignoreCase = true)
}

fun validatedNonProductionBaseUrl(raw: String?): String {
    require(!raw.isNullOrBlank()) {
        "The nonproduction build requires -PhabitatBaseUrl=<isolated backend https URL>. " +
            "There is no production fallback, so the build stops instead of shipping an APK " +
            "with an empty or inherited endpoint."
    }
    val value = raw!!
    require(!value.any { it.isWhitespace() } && !value.contains("\"") && !value.contains("\\")) {
        "The nonproduction base URL may not contain whitespace, quotes, or backslashes."
    }
    val uri = try {
        URI(value)
    } catch (_: Exception) {
        throw GradleException("The nonproduction base URL is not a valid absolute URL: $value")
    }
    require(uri.scheme == "https" || uri.scheme == "http") {
        "The nonproduction base URL must be http(s): $value"
    }
    require(!uri.host.isNullOrBlank()) { "The nonproduction base URL has no host: $value" }
    require(uri.userInfo == null) { "The nonproduction base URL may not embed credentials." }
    val host = uri.host.lowercase()
    require(host != productionHost && !host.endsWith(".$productionHost")) {
        "Refusing to build a nonproduction APK against the production host ($host). " +
            "Use the isolated nonproduction service URL."
    }
    return value
}

val nonProductionBaseUrl = if (nonProductionRequested) validatedNonProductionBaseUrl(requestedBaseUrl) else ""

android {
    namespace = "com.habitat"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.habitat.axbridge"
        minSdk = 26
        targetSdk = 35
        versionCode = 86
        versionName = "0.9.0"
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        manifestPlaceholders["appLabel"] = "Habitat AX Bridge"
    }

    buildFeatures { buildConfig = true }

    flavorDimensions += "environment"
    productFlavors {
        create("production") {
            dimension = "environment"
            buildConfigField("String", "HABITAT_ENVIRONMENT", "\"production\"")
            buildConfigField("String", "HABITAT_BASE_URL", "\"$productionBaseUrl\"")
        }
        create("nonproduction") {
            dimension = "environment"
            // A different package id keeps nonproduction installs, credentials, and Android
            // Keystore entries from ever sharing state with the production app.
            applicationIdSuffix = ".nonprod"
            versionNameSuffix = "-nonprod"
            manifestPlaceholders["appLabel"] = "Habitat NX (nonproduction)"
            buildConfigField("String", "HABITAT_ENVIRONMENT", "\"nonproduction\"")
            buildConfigField("String", "HABITAT_BASE_URL", "\"$nonProductionBaseUrl\"")
        }
    }

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
