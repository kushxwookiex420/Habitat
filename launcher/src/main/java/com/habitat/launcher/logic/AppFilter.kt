package com.habitat.launcher.logic

/** Minimal app shape the filtering logic needs; the UI adds the icon. */
data class FilterableApp(
    val packageName: String,
    val label: String,
    val category: Int,
    val isGame: Boolean = false
)

enum class AppCategoryFilter(val label: String) {
    ALL("All"),
    FAVORITES("Favorites"),
    GAMES("Games"),
    MEDIA("Media"),
    SOCIAL("Social"),
    PRODUCTIVITY("Work"),
    TOOLS("Tools")
}

object AppFilter {
    // ApplicationInfo category constants: 0 GAME, 1 AUDIO, 2 VIDEO, 3 IMAGE, 4 SOCIAL,
    // 5 NEWS, 6 MAPS, 7 PRODUCTIVITY, 8 ACCESSIBILITY, -1 UNDEFINED.
    fun categoryOf(app: FilterableApp): AppCategoryFilter = when {
        app.isGame || app.category == 0 -> AppCategoryFilter.GAMES
        app.category == 1 || app.category == 2 || app.category == 3 -> AppCategoryFilter.MEDIA
        app.category == 4 -> AppCategoryFilter.SOCIAL
        app.category == 7 -> AppCategoryFilter.PRODUCTIVITY
        else -> AppCategoryFilter.TOOLS
    }

    fun matches(app: FilterableApp, query: String, category: AppCategoryFilter, favorites: Set<String>): Boolean {
        if (category == AppCategoryFilter.FAVORITES && app.packageName !in favorites) return false
        if (category != AppCategoryFilter.ALL && category != AppCategoryFilter.FAVORITES &&
            categoryOf(app) != category
        ) return false
        val trimmed = query.trim()
        if (trimmed.isEmpty()) return true
        return app.label.contains(trimmed, ignoreCase = true) ||
            app.packageName.contains(trimmed, ignoreCase = true)
    }

    fun filter(
        apps: List<FilterableApp>,
        query: String,
        category: AppCategoryFilter,
        favorites: Set<String>
    ): List<FilterableApp> = apps.filter { matches(it, query, category, favorites) }
}
