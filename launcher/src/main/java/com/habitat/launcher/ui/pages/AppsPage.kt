package com.habitat.launcher.ui.pages

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.habitat.launcher.data.InstalledApp
import com.habitat.launcher.data.LauncherFolder
import com.habitat.launcher.data.LauncherModel
import com.habitat.launcher.logic.AppCategoryFilter
import com.habitat.launcher.logic.AppFilter
import com.habitat.launcher.logic.FilterableApp
import com.habitat.launcher.ui.components.AppIcon
import com.habitat.launcher.ui.components.EmptyState
import com.habitat.launcher.ui.components.GlassCard
import com.habitat.launcher.ui.components.SectionHeader
import com.habitat.launcher.ui.theme.Cyan
import com.habitat.launcher.ui.theme.Ice
import com.habitat.launcher.ui.theme.Muted
import com.habitat.launcher.ui.theme.Void
import kotlin.math.roundToInt

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AppsPage(model: LauncherModel, onToast: (String) -> Unit) {
    var query by remember { mutableStateOf("") }
    var category by remember { mutableStateOf(AppCategoryFilter.ALL) }
    var actionApp by remember { mutableStateOf<InstalledApp?>(null) }
    var newFolderOpen by remember { mutableStateOf(false) }
    var openFolder by remember { mutableStateOf<LauncherFolder?>(null) }
    val context = LocalContext.current

    val filtered = remember(model.apps, query, category, model.favorites) {
        val filterable = model.apps.map { FilterableApp(it.packageName, it.label, it.category, it.isGame) }
        val matches = AppFilter.filter(filterable, query, category, model.favorites.toSet()).map { it.packageName }.toSet()
        model.apps.filter { it.packageName in matches }
    }
    val favoriteApps = model.favorites.mapNotNull { packageName -> model.apps.firstOrNull { it.packageName == packageName } }
    val recentApps = model.recents.mapNotNull { packageName -> model.apps.firstOrNull { it.packageName == packageName } }.take(6)

    LazyVerticalGrid(
        columns = GridCells.Fixed(4),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 110.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("Search applications", color = Muted) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, tint = Cyan) },
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { query = "" }) {
                            Icon(Icons.Filled.Close, contentDescription = "Clear", tint = Muted)
                        }
                    }
                },
                singleLine = true,
                shape = RoundedCornerShape(18.dp)
            )
        }
        item(span = { GridItemSpan(maxLineSpan) }) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(AppCategoryFilter.values().size) { index ->
                    val option = AppCategoryFilter.values()[index]
                    FilterChip(
                        selected = category == option,
                        onClick = { category = option },
                        label = { Text(option.label, color = if (category == option) Void else Ice) }
                    )
                }
            }
        }
        if (favoriteApps.isNotEmpty()) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                SectionHeader("Favorites", "Long-press and drag to reorder")
            }
            item(span = { GridItemSpan(maxLineSpan) }) {
                FavoriteDragRow(model, favoriteApps, onOpen = { packageName ->
                    if (!model.openApp(packageName)) onToast("Could not open that app.")
                })
            }
        }
        if (recentApps.isNotEmpty()) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                SectionHeader("Recently used")
            }
            item(span = { GridItemSpan(maxLineSpan) }) {
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    for (app in recentApps) {
                        Column(
                            Modifier.width(62.dp).clip(RoundedCornerShape(14.dp))
                                .combinedClickable(
                                    onClick = { if (!model.openApp(app.packageName)) onToast("Could not open that app.") },
                                    onLongClick = { actionApp = app }
                                )
                                .padding(vertical = 4.dp),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            AppIcon(app, size = 38)
                            Spacer(Modifier.height(4.dp))
                            Text(
                                app.label,
                                fontSize = 9.sp,
                                color = Muted,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = TextAlign.Center
                            )
                        }
                    }
                }
            }
        }
        item(span = { GridItemSpan(maxLineSpan) }) {
            SectionHeader(
                "Folders",
                if (model.folders.isEmpty()) "Create a collection of apps" else null,
                trailing = {
                    IconButton(onClick = { newFolderOpen = true }) {
                        Icon(Icons.Filled.Add, contentDescription = "New folder", tint = Cyan)
                    }
                }
            )
        }
        item(span = { GridItemSpan(maxLineSpan) }) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (model.folders.isEmpty()) {
                    item {
                        AssistChip(
                            onClick = { newFolderOpen = true },
                            label = { Text("New folder", color = Ice) },
                            leadingIcon = { Icon(Icons.Filled.Add, contentDescription = null, tint = Cyan) }
                        )
                    }
                }
                items(model.folders.size) { index ->
                    val folder = model.folders[index]
                    AssistChip(
                        onClick = { openFolder = folder },
                        label = { Text(folder.name + "  " + folder.packages.size, color = Ice) }
                    )
                }
            }
        }
        item(span = { GridItemSpan(maxLineSpan) }) {
            SectionHeader(
                "Installed",
                "${filtered.size} of ${model.apps.size} applications",
                trailing = {
                    if (category != AppCategoryFilter.ALL) {
                        TextButton(onClick = { category = AppCategoryFilter.ALL }) { Text("Clear filter", color = Cyan) }
                    }
                }
            )
        }
        if (filtered.isEmpty()) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                EmptyState(
                    if (model.apps.isEmpty()) "Applications are still loading" else "Nothing matched",
                    if (model.apps.isEmpty()) "The launcher is reading the installed application list."
                    else "Try another search or category."
                )
            }
        }
        items(filtered, key = { it.packageName }) { app ->
            AppTile(app) { if (!model.openApp(app.packageName)) onToast("Could not open ${app.label}.") }
                { actionApp = app }
        }
    }

    actionApp?.let { app ->
        AppActionDialog(
            app = app,
            favorites = app.packageName in model.favorites,
            folders = model.folders,
            onDismiss = { actionApp = null },
            onFavorite = { model.toggleFavorite(app.packageName); actionApp = null },
            onAddToFolder = { folder -> model.addToFolder(folder, app.packageName); actionApp = null; onToast("Added to $folder.") },
            onAppInfo = {
                actionApp = null
                runCatching {
                    context.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + app.packageName))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                }.onFailure { onToast("Application settings are unavailable.") }
            }
        )
    }

    if (newFolderOpen) {
        NewFolderDialog(
            onDismiss = { newFolderOpen = false },
            onCreate = { name ->
                if (model.createFolder(name)) {
                    newFolderOpen = false
                    onToast("Folder created.")
                } else {
                    onToast("Enter a unique folder name.")
                }
            }
        )
    }

    openFolder?.let { folder ->
        FolderSheet(
            folder = folder,
            model = model,
            onDismiss = { openFolder = null },
            onOpenApp = { packageName -> if (!model.openApp(packageName)) onToast("Could not open that app.") },
            onRemove = { packageName -> model.removeFromFolder(folder.name, packageName) },
            onDelete = { model.deleteFolder(folder.name); openFolder = null }
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AppTile(app: InstalledApp, onOpen: () -> Unit, onLongPress: () -> Unit) {
    Column(
        Modifier
            .clip(RoundedCornerShape(16.dp))
            .combinedClickable(onClick = onOpen, onLongClick = onLongPress)
            .padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        AppIcon(app, size = 52)
        Spacer(Modifier.height(6.dp))
        Text(
            app.label,
            fontSize = 10.sp,
            color = Ice,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center
        )
    }
}

@Composable
private fun FavoriteDragRow(model: LauncherModel, apps: List<InstalledApp>, onOpen: (String) -> Unit) {
    val density = LocalDensity.current
    val slotPx = with(density) { 84.dp.toPx() }
    var dragging by remember { mutableStateOf<String?>(null) }
    var dragOffset by remember { mutableFloatStateOf(0f) }

    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        items(apps.size) { index ->
            val app = apps[index]
            Column(
                Modifier
                    .width(74.dp)
                    .graphicsLayer {
                        translationX = if (dragging == app.packageName) dragOffset else 0f
                        alpha = if (dragging == app.packageName) 0.82f else 1f
                    }
                    .pointerInput(app.packageName) {
                        detectDragGesturesAfterLongPress(
                            onDragStart = {
                                dragging = app.packageName
                                dragOffset = 0f
                            },
                            onDrag = { change, amount ->
                                change.consume()
                                dragOffset += amount.x
                            },
                            onDragEnd = {
                                val slots = (dragOffset / slotPx).roundToInt()
                                if (slots != 0) model.moveFavorite(app.packageName, slots)
                                dragging = null
                                dragOffset = 0f
                            },
                            onDragCancel = {
                                dragging = null
                                dragOffset = 0f
                            }
                        )
                    }
                    .clip(RoundedCornerShape(14.dp))
                    .combinedClickable(onClick = { onOpen(app.packageName) }, onLongClick = { onOpen(app.packageName) })
                    .padding(vertical = 4.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                AppIcon(app, size = 44)
                Spacer(Modifier.height(4.dp))
                Text(
                    app.label,
                    fontSize = 9.sp,
                    color = Muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center
                )
            }
        }
    }
}

@Composable
private fun AppActionDialog(
    app: InstalledApp,
    favorites: Boolean,
    folders: List<LauncherFolder>,
    onDismiss: () -> Unit,
    onFavorite: () -> Unit,
    onAddToFolder: (String) -> Unit,
    onAppInfo: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(app.label, color = Ice) },
        text = {
            Column {
                Text(app.packageName, style = MaterialTheme.typography.bodyMedium, color = Muted)
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = onFavorite) {
                    Text(if (favorites) "Remove from favorites" else "Add to favorites", color = Cyan)
                }
                for (folder in folders) {
                    TextButton(onClick = { onAddToFolder(folder.name) }) {
                        Text("Add to ${folder.name}", color = Cyan)
                    }
                }
                TextButton(onClick = onAppInfo) { Text("App info", color = Cyan) }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close", color = Muted) } },
        containerColor = com.habitat.launcher.ui.theme.DeepNavy
    )
}

@Composable
private fun NewFolderDialog(onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New folder", color = Ice) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                singleLine = true,
                placeholder = { Text("Folder name", color = Muted) }
            )
        },
        confirmButton = { TextButton(onClick = { onCreate(name) }) { Text("Create", color = Cyan) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = Muted) } },
        containerColor = com.habitat.launcher.ui.theme.DeepNavy
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FolderSheet(
    folder: LauncherFolder,
    model: LauncherModel,
    onDismiss: () -> Unit,
    onOpenApp: (String) -> Unit,
    onRemove: (String) -> Unit,
    onDelete: () -> Unit
) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = com.habitat.launcher.ui.theme.DeepNavy) {
        Column(Modifier.navigationBarsPadding().padding(horizontal = 22.dp, vertical = 6.dp)) {
            Text(folder.name, style = MaterialTheme.typography.headlineMedium, color = Ice)
            Text("${folder.packages.size} apps", style = MaterialTheme.typography.bodyMedium, color = Muted)
            Spacer(Modifier.height(10.dp))
            if (folder.packages.isEmpty()) {
                Text(
                    "Long-press any app and choose this folder to add it.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Muted
                )
            }
            for (packageName in folder.packages) {
                val app = model.apps.firstOrNull { it.packageName == packageName }
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (app != null) {
                        AppIcon(app, size = 38)
                        Spacer(Modifier.width(12.dp))
                    }
                    Text(
                        app?.label ?: packageName,
                        style = MaterialTheme.typography.titleMedium,
                        color = Ice,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { onOpenApp(packageName) }) { Text("Open", color = Cyan) }
                    IconButton(onClick = { onRemove(packageName) }) {
                        Icon(Icons.Filled.Close, contentDescription = "Remove", tint = Muted)
                    }
                }
            }
            Row(Modifier.padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                TextButton(onClick = onDelete) { Text("Delete folder", color = com.habitat.launcher.ui.theme.Danger) }
                TextButton(onClick = onDismiss) { Text("Close", color = Muted) }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}
