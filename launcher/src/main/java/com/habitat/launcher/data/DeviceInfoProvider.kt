package com.habitat.launcher.data

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs

data class DeviceSnapshot(
    val batteryPercent: Int,
    val charging: Boolean,
    val online: Boolean,
    val storageFreeGb: Double,
    val storageTotalGb: Double,
    val ramFreeMb: Int,
    val model: String,
    val androidVersion: String
)

object DeviceInfoProvider {
    fun snapshot(context: Context): DeviceSnapshot {
        val batteryIntent = runCatching {
            context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        }.getOrNull()
        val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val percent = if (level >= 0 && scale > 0) level * 100 / scale else -1
        val status = batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL

        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val capabilities = connectivity?.activeNetwork?.let(connectivity::getNetworkCapabilities)
        val online = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true

        val stats = runCatching { StatFs(Environment.getDataDirectory().absolutePath) }.getOrNull()
        val total = stats?.let { it.blockCountLong * it.blockSizeLong } ?: 0L
        val free = stats?.let { it.availableBlocksLong * it.blockSizeLong } ?: 0L

        val memory = ActivityManager.MemoryInfo()
        (context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)?.getMemoryInfo(memory)

        return DeviceSnapshot(
            batteryPercent = percent,
            charging = charging,
            online = online,
            storageFreeGb = free.toDouble() / 1_073_741_824.0,
            storageTotalGb = total.toDouble() / 1_073_741_824.0,
            ramFreeMb = (memory.availMem / 1_048_576L).toInt(),
            model = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            androidVersion = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
        )
    }
}
