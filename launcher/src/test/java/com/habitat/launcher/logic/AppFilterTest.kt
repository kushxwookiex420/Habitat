package com.habitat.launcher.logic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppFilterTest {
    private val camera = FilterableApp("com.android.camera", "Camera", 2)
    private val chat = FilterableApp("com.example.chat", "Chat", 4)
    private val work = FilterableApp("com.example.docs", "Docs", 7)
    private val game = FilterableApp("com.example.game", "Racer", 0, isGame = true)
    private val tiktok = FilterableApp("com.zhiliaoapp.musically", "TikTok", 4)
    private val apps = listOf(camera, chat, work, game, tiktok)

    @Test
    fun `search is case insensitive on label and package`() {
        assertEquals(listOf(camera), AppFilter.filter(apps, "cam", AppCategoryFilter.ALL, emptySet()))
        assertEquals(listOf(tiktok), AppFilter.filter(apps, "ZHILIAO", AppCategoryFilter.ALL, emptySet()))
    }

    @Test
    fun `empty query returns everything in the category`() {
        assertEquals(5, AppFilter.filter(apps, "", AppCategoryFilter.ALL, emptySet()).size)
        assertEquals(listOf(game), AppFilter.filter(apps, "", AppCategoryFilter.GAMES, emptySet()))
    }

    @Test
    fun `favorites filter intersects with the query`() {
        val favorites = setOf(camera.packageName, chat.packageName)
        assertEquals(2, AppFilter.filter(apps, "", AppCategoryFilter.FAVORITES, favorites).size)
        assertEquals(listOf(chat), AppFilter.filter(apps, "chat", AppCategoryFilter.FAVORITES, favorites))
    }

    @Test
    fun `category mapping covers games media social work and tools`() {
        assertEquals(AppCategoryFilter.GAMES, AppFilter.categoryOf(game))
        assertEquals(AppCategoryFilter.MEDIA, AppFilter.categoryOf(camera))
        assertEquals(AppCategoryFilter.SOCIAL, AppFilter.categoryOf(chat))
        assertEquals(AppCategoryFilter.PRODUCTIVITY, AppFilter.categoryOf(work))
        assertEquals(AppCategoryFilter.TOOLS, AppFilter.categoryOf(FilterableApp("x", "X", -1)))
    }

    @Test
    fun `search with no match returns empty instead of everything`() {
        assertTrue(AppFilter.filter(apps, "nothing-like-this", AppCategoryFilter.ALL, emptySet()).isEmpty())
    }
}
