package com.habitat.launcher.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class LauncherFolder(val name: String, val packages: List<String>)

/**
 * Launcher-owned preferences. It deliberately stores no Habitat credential: the launcher reads the
 * public, read-only status endpoints and never performs authorized device actions.
 */
class LauncherPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("habitat_launcher", Context.MODE_PRIVATE)

    var pageOrder: String
        get() = prefs.getString("page_order", "") ?: ""
        set(value) = prefs.edit().putString("page_order", value).apply()

    var baseUrl: String
        get() = prefs.getString("base_url", DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL
        set(value) = prefs.edit().putString("base_url", value).apply()

    // An ordered list, not a Set: favorites can be dragged into a personal order.
    var favorites: List<String>
        get() = prefs.getString("favorites_order", "").orEmpty().split("|").filter { it.isNotBlank() }
        set(value) = prefs.edit().putString("favorites_order", value.distinct().joinToString("|")).apply()

    var recents: List<String>
        get() = prefs.getString("recents", "").orEmpty().split("|").filter { it.isNotBlank() }
        set(value) = prefs.edit().putString("recents", value.take(12).joinToString("|")).apply()

    var folders: List<LauncherFolder>
        get() = parseFolders(prefs.getString("folders", "[]") ?: "[]")
        set(value) = prefs.edit().putString("folders", encodeFolders(value)).apply()

    var taskbar: Boolean
        get() = prefs.getBoolean("taskbar", true)
        set(value) = prefs.edit().putBoolean("taskbar", value).apply()

    var swipeUpSearch: Boolean
        get() = prefs.getBoolean("swipe_up_search", true)
        set(value) = prefs.edit().putBoolean("swipe_up_search", value).apply()

    fun recordRecent(packageName: String) {
        recents = listOf(packageName) + recents.filter { it != packageName }
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://habitat-1-szzd.onrender.com"

        fun parseFolders(json: String): List<LauncherFolder> = runCatching {
            val array = JSONArray(json)
            buildList {
                for (index in 0 until array.length()) {
                    val folder = array.optJSONObject(index) ?: continue
                    val packages = mutableListOf<String>()
                    folder.optJSONArray("packages")?.let { list ->
                        for (packageIndex in 0 until list.length()) {
                            list.optString(packageIndex).takeIf { it.isNotBlank() }?.let(packages::add)
                        }
                    }
                    val name = folder.optString("name").trim()
                    if (name.isNotEmpty()) add(LauncherFolder(name, packages.distinct()))
                }
            }
        }.getOrDefault(emptyList())

        fun encodeFolders(folders: List<LauncherFolder>): String {
            val array = JSONArray()
            for (folder in folders) {
                val packages = JSONArray()
                folder.packages.forEach(packages::put)
                array.put(JSONObject().put("name", folder.name).put("packages", packages))
            }
            return array.toString()
        }
    }
}
