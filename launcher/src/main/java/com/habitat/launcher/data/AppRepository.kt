package com.habitat.launcher.data

import android.content.Context
import android.content.Intent
import android.graphics.drawable.Drawable

data class InstalledApp(
    val packageName: String,
    val label: String,
    val category: Int,
    val icon: Drawable?
) {
    val isGame: Boolean get() = category == 0
}

class AppRepository(context: Context) {
    private val appContext = context.applicationContext
    private val packageManager = appContext.packageManager

    fun load(): List<InstalledApp> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolved = runCatching { packageManager.queryIntentActivities(intent, 0) }.getOrDefault(emptyList())
        return resolved.mapNotNull { info ->
            val activity = info.activityInfo ?: return@mapNotNull null
            val application = activity.applicationInfo ?: return@mapNotNull null
            if (application.packageName == appContext.packageName) return@mapNotNull null
            InstalledApp(
                packageName = application.packageName,
                label = runCatching { application.loadLabel(packageManager).toString() }
                    .getOrDefault(application.packageName),
                category = application.category,
                icon = runCatching { application.loadIcon(packageManager) }.getOrNull()
            )
        }.distinctBy { it.packageName }.sortedBy { it.label.lowercase() }
    }

    fun launch(packageName: String): Boolean {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        return runCatching {
            appContext.startActivity(intent)
            true
        }.getOrDefault(false)
    }

    fun packageInstalled(packageName: String): Boolean =
        runCatching { packageManager.getLaunchIntentForPackage(packageName) != null }.getOrDefault(false)
}
