package com.habitat.launcher.data

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.habitat.launcher.logic.PageOrder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class LauncherModel(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = LauncherPrefs(appContext)
    private val appRepository = AppRepository(appContext)
    private val habitatClient = HabitatClient { baseUrl }

    var pageOrder by mutableStateOf(PageOrder.fromCsv(prefs.pageOrder)); private set
    var apps by mutableStateOf<List<InstalledApp>>(emptyList()); private set
    var favorites by mutableStateOf(prefs.favorites); private set
    var recents by mutableStateOf(prefs.recents); private set
    var folders by mutableStateOf(prefs.folders); private set
    var baseUrl by mutableStateOf(prefs.baseUrl); private set
    var taskbar by mutableStateOf(prefs.taskbar); private set
    var swipeUpSearch by mutableStateOf(prefs.swipeUpSearch); private set

    var workers by mutableStateOf<List<WorkerSummary>>(emptyList()); private set
    var habitatStatus by mutableStateOf<HabitatStatus?>(null); private set
    var tasks by mutableStateOf<List<TaskSummary>>(emptyList()); private set
    var habitatLoading by mutableStateOf(false); private set
    var habitatError by mutableStateOf<String?>(null); private set
    var lastSyncAt by mutableStateOf<Long?>(null); private set
    var device by mutableStateOf<DeviceSnapshot?>(null); private set

    suspend fun loadApps() {
        apps = withContext(Dispatchers.IO) { appRepository.load() }
    }

    suspend fun refreshHabitat() {
        habitatLoading = true
        habitatError = null
        val statusResult = habitatClient.status()
        val workersResult = habitatClient.workers()
        val tasksResult = habitatClient.tasks()

        val failure = statusResult.exceptionOrNull() ?: workersResult.exceptionOrNull() ?: tasksResult.exceptionOrNull()
        if (failure != null) {
            habitatError = failure.message ?: "Habitat did not answer."
        } else {
            habitatStatus = runCatching { HabitatParsers.status(statusResult.getOrThrow()) }.getOrNull()
            workers = runCatching { HabitatParsers.workers(workersResult.getOrThrow()) }.getOrDefault(emptyList())
            tasks = runCatching { HabitatParsers.tasks(tasksResult.getOrThrow()) }.getOrDefault(emptyList())
            lastSyncAt = System.currentTimeMillis()
        }
        device = DeviceInfoProvider.snapshot(appContext)
        habitatLoading = false
    }

    fun refreshDevice() {
        device = DeviceInfoProvider.snapshot(appContext)
    }

    suspend fun loadTaskReceipt(id: String): Result<TaskReceipt> =
        habitatClient.task(id).mapCatching { TaskReceiptParser.parseTaskDetail(it) }

    fun movePage(id: String, delta: Int) {
        pageOrder = PageOrder.move(pageOrder, id, delta)
        prefs.pageOrder = PageOrder.toCsv(pageOrder)
    }

    fun resetPageOrder() {
        pageOrder = PageOrder.normalize(PageOrder.known)
        prefs.pageOrder = PageOrder.toCsv(pageOrder)
    }

    fun saveBaseUrl(url: String) {
        val trimmed = url.trim().trimEnd('/')
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            baseUrl = trimmed
            prefs.baseUrl = trimmed
        }
    }

    fun updateTaskbar(enabled: Boolean) {
        taskbar = enabled
        prefs.taskbar = enabled
    }

    fun updateSwipeUpSearch(enabled: Boolean) {
        swipeUpSearch = enabled
        prefs.swipeUpSearch = enabled
    }

    fun toggleFavorite(packageName: String) {
        favorites = if (packageName in favorites) favorites - packageName else favorites + packageName
        prefs.favorites = favorites
    }

    fun moveFavorite(packageName: String, delta: Int) {
        val list = favorites.toMutableList()
        val index = list.indexOf(packageName)
        if (index < 0) return
        val target = (index + delta).coerceIn(0, list.lastIndex)
        if (target == index) return
        list.removeAt(index)
        list.add(target, packageName)
        favorites = list
        prefs.favorites = list
    }

    fun recordRecent(packageName: String) {
        prefs.recordRecent(packageName)
        recents = prefs.recents
    }

    fun openApp(packageName: String): Boolean {
        recordRecent(packageName)
        return appRepository.launch(packageName)
    }

    fun isInstalled(packageName: String): Boolean = appRepository.packageInstalled(packageName)

    fun saveFolders(next: List<LauncherFolder>) {
        folders = next
        prefs.folders = next
    }

    fun createFolder(name: String): Boolean {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || folders.any { it.name.equals(trimmed, ignoreCase = true) }) return false
        saveFolders(folders + LauncherFolder(trimmed, emptyList()))
        return true
    }

    fun addToFolder(name: String, packageName: String) {
        saveFolders(folders.map { folder ->
            if (folder.name == name && packageName !in folder.packages) {
                folder.copy(packages = folder.packages + packageName)
            } else folder
        })
    }

    fun removeFromFolder(name: String, packageName: String) {
        saveFolders(folders.map { folder ->
            if (folder.name == name) folder.copy(packages = folder.packages - packageName) else folder
        })
    }

    fun deleteFolder(name: String) {
        saveFolders(folders.filterNot { it.name == name })
    }

    fun appLabel(packageName: String): String =
        apps.firstOrNull { it.packageName == packageName }?.label ?: packageName
}
