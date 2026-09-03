const api = window.utilityAPI || window.electronAPI;

document.addEventListener('DOMContentLoaded', () => {
    const themesGrid = document.getElementById('themesGrid');
    const previewBox = document.getElementById('previewBox');
    const saveThemeBtn = document.getElementById('saveThemeBtn');
    const container = document.querySelector('.container');
    const themeSearchInput = document.getElementById('themeSearchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const themeCountBadge = document.getElementById('themeCountBadge');
    const noThemesFallback = document.getElementById('noThemesFallback');
    const previewThemeName = document.getElementById('previewThemeName');
    const currentStatusTip = document.getElementById('currentStatusTip');

    let selectedTheme = null;
    let themes = [];
    let searchQuery = '';

    // Helper function to convert hex color to an RGB string "r, g, b"
    function hexToRgb(hex) {
        if (!hex) return null;
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : null;
    }

    // Helper function to convert hex color to a semi-transparent RGBA string
    function hexToRgba(hex, alpha = 0.85) {
        if (!hex || !hex.startsWith('#')) return hex;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    // Function to clean up duplicated path segments
    const fixWallpaperPath = (path) => {
        if (typeof path !== 'string') return path;
        return path.replace(/wallpaper\/wallpaper\//g, 'wallpaper/');
    };

    // Helper to escape single quotes and backslashes for CSS url()
    const escapeCssUrl = (url) => {
        if (typeof url !== 'string') return '';
        return url.replace(/\\/g, '/').replace(/'/g, "\\'");
    };

    // Safe HTML string escape
    function escapeHtml(text) {
        return (text || '').replace(/[&<>"']/g, (m) => ({
            '&': '&',
            '<': '<',
            '>': '>',
            '"': '"',
            "'": '&#039;'
        }[m]));
    }

    // New function to load wallpaper previews using thumbnails
    function loadWallpaperPreview(element, wallpaperPath) {
        if (!element) return;

        if (wallpaperPath && wallpaperPath !== 'none') {
            const fixedPath = fixWallpaperPath(wallpaperPath);
            if (api?.getWallpaperThumbnail) {
                api.getWallpaperThumbnail(fixedPath).then(thumbnailUrl => {
                    const previewUrl = thumbnailUrl || fixedPath;
                    element.style.backgroundImage = `url('${escapeCssUrl(previewUrl)}')`;
                }).catch(err => {
                    console.error(`Failed to generate or load thumbnail for ${fixedPath}:`, err);
                    element.style.backgroundImage = `url('${escapeCssUrl(fixedPath)}')`;
                });
            } else {
                element.style.backgroundImage = `url('${escapeCssUrl(fixedPath)}')`;
            }
        } else {
            element.style.backgroundImage = 'none';
        }
    }

    // 1. Fetch themes from the main process
    if (api?.getThemes) {
        api.getThemes().then(themeList => {
            themes = themeList || [];
            renderThemeCards();
            
            // Prioritize selecting the currently active theme, or the first theme
            const activeTheme = themes.find(t => t.isActive);
            const initialTheme = activeTheme || themes[0];
            if (initialTheme) {
                selectTheme(initialTheme.fileName);
            }
        }).catch(err => {
            console.error('Failed to load themes:', err);
        });
    }

    // 2. Render theme cards with search filtering and visual refinement
    function renderThemeCards() {
        const query = searchQuery.trim().toLowerCase();
        const filteredThemes = themes.filter(theme => {
            if (!query) return true;
            const name = (theme.name || '').toLowerCase();
            const fileName = (theme.fileName || '').toLowerCase();
            return name.includes(query) || fileName.includes(query);
        });

        // Update badge count
        if (themeCountBadge) {
            themeCountBadge.textContent = query
                ? `找到 ${filteredThemes.length} / 共 ${themes.length} 套`
                : `共 ${themes.length} 套主题`;
        }

        themesGrid.innerHTML = '';

        if (filteredThemes.length === 0) {
            if (noThemesFallback) noThemesFallback.style.display = 'flex';
        } else {
            if (noThemesFallback) noThemesFallback.style.display = 'none';
        }

        filteredThemes.forEach(theme => {
            const card = document.createElement('div');
            card.className = 'theme-card';
            card.dataset.fileName = theme.fileName;
            if (selectedTheme && selectedTheme.fileName === theme.fileName) {
                card.classList.add('selected');
            }
            if (theme.isActive) {
                card.classList.add('active-applied');
            }

            // Top preview thumbnail
            const preview = document.createElement('div');
            preview.className = 'card-preview';

            // Active Badge & Selection Checkmark
            const badgeContainer = document.createElement('div');
            badgeContainer.className = 'card-badges';

            if (theme.isActive) {
                const activeTag = document.createElement('span');
                activeTag.className = 'badge-active';
                activeTag.textContent = '当前生效';
                badgeContainer.appendChild(activeTag);
            }

            const checkmark = document.createElement('div');
            checkmark.className = 'card-select-indicator';
            checkmark.innerHTML = `
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            `;
            badgeContainer.appendChild(checkmark);
            preview.appendChild(badgeContainer);

            // Left Pane (Dark preview)
            const pane1 = document.createElement('div');
            pane1.className = 'card-preview-pane-1';
            if (theme.variables?.dark) {
                pane1.style.backgroundColor = theme.variables.dark['--secondary-bg'] || '#172A46';
                loadWallpaperPreview(pane1, theme.variables.dark['--chat-wallpaper-dark']);
            }
            pane1.style.backgroundSize = 'cover';
            pane1.style.backgroundPosition = 'center';

            // Right Pane (Light preview)
            const pane2 = document.createElement('div');
            pane2.className = 'card-preview-pane-2';
            if (theme.variables?.light) {
                pane2.style.backgroundColor = theme.variables.light['--primary-bg'] || '#F0F8FF';
                const lightWallpaper = theme.variables.light['--chat-wallpaper-light'];
                const darkWallpaper = theme.variables?.dark ? theme.variables.dark['--chat-wallpaper-dark'] : 'none';
                loadWallpaperPreview(pane2, lightWallpaper || darkWallpaper);
            }
            pane2.style.backgroundSize = 'cover';
            pane2.style.backgroundPosition = 'center';

            preview.appendChild(pane1);
            preview.appendChild(pane2);

            // Card bottom info
            const info = document.createElement('div');
            info.className = 'card-info';

            const nameEl = document.createElement('h3');
            nameEl.className = 'theme-name';
            
            // Highlight query match if searched
            if (query && theme.name.toLowerCase().includes(query)) {
                const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                nameEl.innerHTML = escapeHtml(theme.name).replace(regex, '<span class="search-highlight">$1</span>');
            } else {
                nameEl.textContent = theme.name;
            }

            // Accent color swatches
            const swatches = document.createElement('div');
            swatches.className = 'card-color-swatches';
            
            const darkAccent = theme.variables?.dark?.['--button-bg'] || '#3b82f6';
            const lightAccent = theme.variables?.light?.['--button-bg'] || '#0284c7';
            const darkBg = theme.variables?.dark?.['--primary-bg'] || '#111827';
            const lightBg = theme.variables?.light?.['--primary-bg'] || '#f8fafc';

            swatches.innerHTML = `
                <span class="swatch" title="深色主色" style="background: ${escapeHtml(darkAccent)}"></span>
                <span class="swatch" title="深色底色" style="background: ${escapeHtml(darkBg)}"></span>
                <span class="swatch" title="浅色主色" style="background: ${escapeHtml(lightAccent)}"></span>
                <span class="swatch" title="浅色底色" style="background: ${escapeHtml(lightBg)}"></span>
            `;

            info.appendChild(nameEl);
            info.appendChild(swatches);

            card.appendChild(preview);
            card.appendChild(info);

            card.addEventListener('click', () => selectTheme(theme.fileName));
            themesGrid.appendChild(card);
        });
    }

    // 3. Select a theme and update the UI
    function selectTheme(fileName) {
        selectedTheme = themes.find(t => t.fileName === fileName);
        if (!selectedTheme) return;

        // Update card selection state
        document.querySelectorAll('.theme-card').forEach(card => {
            card.classList.toggle('selected', card.dataset.fileName === fileName);
        });

        if (previewThemeName) {
            previewThemeName.textContent = selectedTheme.name;
        }

        if (currentStatusTip) {
            currentStatusTip.innerHTML = `当前选定：<strong>${escapeHtml(selectedTheme.name)}</strong>${selectedTheme.isActive ? ' <span class="active-pill">正在生效</span>' : ''}`;
        }

        // Update the main preview with the full variables object { dark, light }
        updatePreview(selectedTheme.variables);
    }

    // 4. Update the live preview area to show both dark and light themes
    function updatePreview(variables) {
        const darkVars = variables.dark;
        const lightVars = variables.light;

        const pane1 = document.getElementById('preview-pane-1');
        const pane2 = document.getElementById('preview-pane-2');
        const wallpaper1 = document.getElementById('preview-wallpaper-1');
        const wallpaper2 = document.getElementById('preview-wallpaper-2');
        const previewButtons1 = document.getElementById('preview-buttons-1');
        const previewButtons2 = document.getElementById('preview-buttons-2');

        // --- Apply Dark Theme to Pane 1 (Left) ---
        if (pane1 && darkVars) {
            pane1.style.setProperty('--secondary-text', darkVars['--secondary-text'] || '#a7afb1');
            pane1.style.setProperty('--primary-text', darkVars['--primary-text'] || '#f2f0e9');
            pane1.style.setProperty('--border-color', darkVars['--border-color'] || 'rgba(255,255,255,0.12)');
            pane1.style.setProperty('--button-bg', darkVars['--button-bg'] || '#007bff');
            pane1.style.setProperty('--user-bubble-bg', darkVars['--user-bubble-bg'] || 'rgba(0,123,255,0.15)');
            pane1.style.setProperty('--assistant-bubble-bg', darkVars['--assistant-bubble-bg'] || 'rgba(32,37,42,0.85)');

            pane1.style.backgroundColor = hexToRgba(darkVars['--secondary-bg'] || '#17202A', 0.82);

            if (wallpaper1) {
                loadWallpaperPreview(wallpaper1, darkVars['--chat-wallpaper-dark']);
            }

            if (previewButtons1) {
                const primaryButton = previewButtons1.querySelector('.preview-button:not(.alt)');
                const altButton = previewButtons1.querySelector('.preview-button.alt');
                const buttonBg = darkVars['--button-bg'] || '#007bff';
                const textOnAccent = darkVars['--text-on-accent'] || '#ffffff';

                if (primaryButton) {
                    primaryButton.style.backgroundColor = buttonBg;
                    primaryButton.style.color = textOnAccent;
                }
                if (altButton) {
                    altButton.style.backgroundColor = 'transparent';
                    altButton.style.color = buttonBg;
                    altButton.style.borderColor = buttonBg;
                }
            }
        }

        // --- Apply Light Theme to Pane 2 (Right) ---
        if (pane2 && lightVars) {
            pane2.style.setProperty('--secondary-text', lightVars['--secondary-text'] || '#626a66');
            pane2.style.setProperty('--primary-text', lightVars['--primary-text'] || '#1b211f');
            pane2.style.setProperty('--border-color', lightVars['--border-color'] || 'rgba(0,0,0,0.12)');
            pane2.style.setProperty('--button-bg', lightVars['--button-bg'] || '#007bff');
            pane2.style.setProperty('--user-bubble-bg', lightVars['--user-bubble-bg'] || 'rgba(0,123,255,0.12)');
            pane2.style.setProperty('--assistant-bubble-bg', lightVars['--assistant-bubble-bg'] || 'rgba(255,255,255,0.88)');

            pane2.style.backgroundColor = hexToRgba(lightVars['--primary-bg'] || '#F4F7F6', 0.85);

            if (wallpaper2) {
                const lightWallpaper = lightVars['--chat-wallpaper-light'];
                const darkWallpaper = darkVars ? fixWallpaperPath(darkVars['--chat-wallpaper-dark']) : 'none';
                loadWallpaperPreview(wallpaper2, lightWallpaper || darkWallpaper);
            }

            if (previewButtons2) {
                const primaryButton = previewButtons2.querySelector('.preview-button:not(.alt)');
                const altButton = previewButtons2.querySelector('.preview-button.alt');
                const buttonBg = lightVars['--button-bg'] || '#007bff';
                const textOnAccent = lightVars['--text-on-accent'] || '#ffffff';

                if (primaryButton) {
                    primaryButton.style.backgroundColor = buttonBg;
                    primaryButton.style.color = textOnAccent;
                }
                if (altButton) {
                    altButton.style.backgroundColor = 'transparent';
                    altButton.style.color = buttonBg;
                    altButton.style.borderColor = buttonBg;
                }
            }
        }
        
        // --- Update container's glow effect ---
        if (darkVars && container) {
            const activeColor = darkVars['--button-bg'] || '#007bff';
            container.style.setProperty('--button-bg', activeColor);
            container.style.setProperty('--button-bg-rgb', hexToRgb(activeColor) || '0, 123, 255');
        }
    }

    // 5. Search events and clearing
    if (themeSearchInput) {
        themeSearchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value;
            if (clearSearchBtn) {
                clearSearchBtn.style.display = searchQuery ? 'flex' : 'none';
            }
            renderThemeCards();
        });

        themeSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchQuery = '';
                themeSearchInput.value = '';
                if (clearSearchBtn) clearSearchBtn.style.display = 'none';
                renderThemeCards();
            }
        });
    }

    if (clearSearchBtn) {
        clearSearchBtn.addEventListener('click', () => {
            searchQuery = '';
            if (themeSearchInput) {
                themeSearchInput.value = '';
                themeSearchInput.focus();
            }
            clearSearchBtn.style.display = 'none';
            renderThemeCards();
        });
    }

    // 6. Save the selected theme with feedback animation
    if (saveThemeBtn) {
        saveThemeBtn.addEventListener('click', () => {
            if (!selectedTheme) return;
            
            const originalHtml = saveThemeBtn.innerHTML;
            saveThemeBtn.disabled = true;
            saveThemeBtn.classList.add('is-applying');
            saveThemeBtn.innerHTML = `
                <svg class="spin-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
                    <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
                </svg>
                <span>正在应用方案...</span>
            `;

            if (api?.applyTheme) {
                api.applyTheme(selectedTheme.fileName);
            }

            setTimeout(() => {
                saveThemeBtn.disabled = false;
                saveThemeBtn.classList.remove('is-applying');
                saveThemeBtn.innerHTML = originalHtml;
            }, 1200);
        });
    }

    // --- Custom Title Bar Listeners ---
    const minimizeBtn = document.getElementById('minimize-theme-btn');
    const maximizeBtn = document.getElementById('maximize-theme-btn');
    const closeBtn = document.getElementById('close-theme-btn');

    minimizeBtn.addEventListener('click', () => {
        if (api) api.minimizeWindow();
    });

    maximizeBtn.addEventListener('click', () => {
        if (api) api.maximizeWindow();
    });

    closeBtn.addEventListener('click', () => {
        if (api?.closeWindow) {
            api.closeWindow();
        } else {
            window.close();
        }
    });
 
     // --- Theme Handling for the window itself ---
     const applyThemeForWindow = (theme) => {
        document.body.classList.toggle('light-theme', theme === 'light');
    };

    async function initializeTheme() {
        try {
            const theme = await api.getCurrentTheme();
            applyThemeForWindow(theme || 'dark');
        } catch (error) {
            console.error('Failed to get initial theme for themes window:', error);
            applyThemeForWindow('dark'); // Fallback
        }
    }

    if (api) {
        initializeTheme();
        api.onThemeUpdated(applyThemeForWindow);
    } else {
        console.warn('utilityAPI not found. Theme updates will not work.');
        applyThemeForWindow('dark');
    }
});
