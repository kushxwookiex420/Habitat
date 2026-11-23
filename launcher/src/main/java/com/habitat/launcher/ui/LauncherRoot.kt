package com.habitat.launcher.ui

import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.habitat.launcher.data.LauncherModel
import com.habitat.launcher.logic.CommandResult
import com.habitat.launcher.logic.CommandRouter
import com.habitat.launcher.logic.LauncherPages
import com.habitat.launcher.ui.components.AppIcon
import com.habitat.launcher.ui.components.LauncherBackdrop
import com.habitat.launcher.ui.components.openUrl
import com.habitat.launcher.ui.pages.AppsPage
import com.habitat.launcher.ui.pages.AxHomePage
import com.habitat.launcher.ui.pages.ComputerPage
import com.habitat.launcher.ui.pages.DevicePage
import com.habitat.launcher.ui.pages.GamingPage
import com.habitat.launcher.ui.pages.HabitatPage
import com.habitat.launcher.ui.pages.IntelligencePage
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.Danger
import com.habitat.launcher.ui.theme.DeepNavy
import com.habitat.launcher.ui.theme.Good
import com.habitat.launcher.ui.theme.Ice
import com.habitat.launcher.ui.theme.Muted
import com.habitat.launcher.ui.theme.Turquoise
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.URLEncoder
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LauncherRoot() {
    val context = LocalContext.current
    val model = remember { LauncherModel(context) }
    val scope = rememberCoroutineScope()
    var searchOpen by remember { mutableStateOf(false) }
    var settingsOpen by remember { mutableStateOf(false) }
    val pagerState = rememberPagerState(pageCount = { model.pageOrder.size })
    val now = rememberClock()

    LaunchedEffect(Unit) {
        model.loadApps()
        model.refreshHabitat()
    }
    LaunchedEffect(model.pageOrder.size) {
        if (pagerState.currentPage > model.pageOrder.lastIndex) {
            pagerState.scrollToPage(model.pageOrder.lastIndex.coerceAtLeast(0))
        }
    }

    val toast: (String) -> Unit = { message -> Toast.makeText(context, message, Toast.LENGTH_SHORT).show() }
    val navigate: (String) -> Unit = { id ->
        val index = model.pageOrder.indexOf(id)
        if (index >= 0) scope.launch { pagerState.animateScrollToPage(index) }
    }
    val command: (String) -> Unit = { raw ->
        when (val result = CommandRouter.route(raw)) {
            is CommandResult.Navigate -> {
                navigate(result.pageId)
                toast("Showing ${LauncherPages.byId(result.pageId).title}")
            }
            is CommandResult.OpenApp -> {
                val query = result.query.lowercase()
                val app = model.apps.firstOrNull {
                    it.label.lowercase().contains(query) || it.packageName.lowercase() == query
                }
                when {
                    app == null -> toast("No installed app matched \"${result.query}\".")
                    model.openApp(app.packageName) -> toast("Opening ${app.label}")
                    else -> toast("${app.label} could not be opened.")
                }
            }
            is CommandResult.WebSearch -> {
                val encoded = URLEncoder.encode(result.query, "UTF-8")
                if (openUrl(context, "https://www.google.com/search?q=$encoded")) {
                    toast("Opening web search")
                } else {
                    toast("No browser is available.")
                }
            }
            is CommandResult.Reply -> {
                if (result.message.startsWith("Refreshing")) {
                    scope.launch { model.refreshHabitat() }
                    toast("Refreshing Habitat…")
                } else {
                    toast(result.message)
                }
            }
            is CommandResult.Unsupported -> toast("Not available yet: \"${result.input}\". Say \"help\".")
        }
    }

    Box(Modifier.fillMaxSize()) {
        LauncherBackdrop()
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            TopBar(
                pageLabel = LauncherPages.byId(model.pageOrder.getOrNull(pagerState.currentPage) ?: "ax").title,
                connected = model.habitatStatus?.ok == true && model.habitatError == null,
                now = now,
                onSearch = { searchOpen = true },
                onSettings = { settingsOpen = true }
            )
            HorizontalPager(
                state = pagerState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                beyondViewportPageCount = 1
            ) { index ->
                when (model.pageOrder.getOrNull(index) ?: "ax") {
                    "ax" -> AxHomePage(model, onNavigate = navigate, onSearch = { searchOpen = true }, onCommand = command, onToast = toast)
                    "apps" -> AppsPage(model, onToast = toast)
                    "computer" -> ComputerPage(model, onToast = toast)
                    "habitat" -> HabitatPage(model, onNavigate = navigate, onToast = toast)
                    "intelligence" -> IntelligencePage(model, onSearch = { searchOpen = true }, onCommand = command, onToast = toast)
                    "gaming" -> GamingPage(model, onToast = toast)
                    "device" -> DevicePage(model, onNavigate = navigate, onToast = toast)
                    else -> AxHomePage(model, onNavigate = navigate, onSearch = { searchOpen = true }, onCommand = command, onToast = toast)
                }
            }
            if (model.taskbar) {
                AppDock(model = model, onOpen = { packageName ->
                    if (!model.openApp(packageName)) toast("Could not open that app.")
                })
            }
            PageRail(
                titles = model.pageOrder.map { LauncherPages.byId(it).title },
                current = pagerState.currentPage,
                onSelect = { page -> scope.launch { pagerState.animateScrollToPage(page) } }
            )
            if (model.swipeUpSearch) {
                SwipeUpHandle { searchOpen = true }
            }
        }
    }

    if (searchOpen) {
        SearchOverlay(
            model = model,
            onDismiss = { searchOpen = false },
            onNavigate = { id -> searchOpen = false; navigate(id) },
            onOpenApp = { packageName ->
                searchOpen = false
                if (!model.openApp(packageName)) toast("Could not open that app.")
            }
        )
    }
    if (settingsOpen) {
        SettingsSheet(model = model, onDismiss = { settingsOpen = false }, onToast = toast)
    }
}

@Composable
private fun rememberClock(): LocalDateTime {
    var now by remember { mutableStateOf(LocalDateTime.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(15_000)
            now = LocalDateTime.now()
        }
    }
    return now
}

@Composable
private fun TopBar(
    pageLabel: String,
    connected: Boolean,
    now: LocalDateTime,
    onSearch: () -> Unit,
    onSettings: () -> Unit
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(if (connected) Good else Danger))
                Spacer(Modifier.width(8.dp))
                Text("HABITAT", style = MaterialTheme.typography.labelLarge, color = Ice)
                Spacer(Modifier.width(8.dp))
                Text("AX", style = MaterialTheme.typography.labelLarge, color = Cyan)
            }
            Text(
                pageLabel.uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = Muted,
                modifier = Modifier.padding(top = 2.dp)
            )
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(
                now.format(DateTimeFormatter.ofPattern("HH:mm")),
                style = MaterialTheme.typography.titleLarge,
                color = Ice
            )
            Text(
                now.format(DateTimeFormatter.ofPattern("EEE d MMM")),
                style = MaterialTheme.typography.labelSmall,
                color = Muted
            )
        }
        Spacer(Modifier.width(6.dp))
        IconButton(onClick = onSearch) { Icon(Icons.Filled.Search, contentDescription = "Search", tint = Ice) }
        IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = Ice) }
    }
}

@Composable
private fun AppDock(model: LauncherModel, onOpen: (String) -> Unit) {
    val packages = (model.recents + model.favorites).distinct()
        .mapNotNull { packageName -> model.apps.firstOrNull { it.packageName == packageName } }
        .take(4)
    if (packages.isEmpty()) return
    Row(
        Modifier
            .padding(horizontal = 20.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(DeepNavy.copy(alpha = 0.82f))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
        verticalAlignment = Alignment.CenterVertically
    ) {
        for (app in packages) {
            Box(
                Modifier.clip(CircleShape).clickable { onOpen(app.packageName) }.padding(10.dp)
            ) {
                AppIcon(app, size = 34)
            }
        }
    }
}

@Composable
private fun PageRail(titles: List<String>, current: Int, onSelect: (Int) -> Unit) {
    Row(
        Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        for (index in titles.indices) {
            Box(
                Modifier
                    .padding(horizontal = 4.dp)
                    .size(if (index == current) 18.dp else 7.dp)
                    .clip(CircleShape)
                    .background(if (index == current) Turquoise else Muted.copy(alpha = 0.35f))
                    .clickable { onSelect(index) }
            )
        }
    }
}

@Composable
private fun SwipeUpHandle(onOpenSearch: () -> Unit) {
    var total by remember { mutableStateOf(0f) }
    Box(
        Modifier
            .fillMaxWidth()
            .height(26.dp)
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onDragEnd = {
                        if (total < -90f) onOpenSearch()
                        total = 0f
                    },
                    onDragCancel = { total = 0f },
                    onVerticalDrag = { change, amount ->
                        total += amount
                        change.consume()
                    }
                )
            },
        contentAlignment = Alignment.Center
    ) {
        Box(Modifier.width(44.dp).height(3.dp).clip(RoundedCornerShape(2.dp)).background(Muted.copy(alpha = 0.35f)))
    }
}
