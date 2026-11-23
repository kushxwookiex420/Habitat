package com.habitat.launcher.logic

data class LauncherPage(val id: String, val title: String, val kicker: String)

object LauncherPages {
    val all = listOf(
        LauncherPage("ax", "AX Home", "Command core"),
        LauncherPage("apps", "Applications", "Everything installed"),
        LauncherPage("computer", "Computer", "Linux, remote and workspace"),
        LauncherPage("habitat", "Habitat", "Workers, tasks and receipts"),
        LauncherPage("intelligence", "Intelligence", "Research and AX tools"),
        LauncherPage("gaming", "Gaming", "Native, Winlator and cloud"),
        LauncherPage("device", "Device Control", "Status, storage and links")
    )

    fun byId(id: String): LauncherPage = all.firstOrNull { it.id == id } ?: all.first()
}
