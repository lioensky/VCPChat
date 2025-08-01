document.addEventListener('DOMContentLoaded', () => {
    const themesGrid = document.getElementById('themesGrid');
    const previewBox = document.getElementById('previewBox');
    const saveThemeBtn = document.getElementById('saveThemeBtn');
    const container = document.querySelector('.container');

    let selectedTheme = null;
    let themes = [];

    // Helper function to convert hex color to an RGB string "r, g, b"
    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : null;
    }

    // Helper function to convert hex color to a semi-transparent RGBA string
    function hexToRgba(hex, alpha = 0.85) {
        if (!hex || !hex.startsWith('#')) return hex; // Return original if not a valid hex color
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
       // Replace backslashes with forward slashes for CSS compatibility
       return url.replace(/\\/g, '/').replace(/'/g, "\\'");
   };

   // New function to load wallpaper previews using thumbnails
   function loadWallpaperPreview(element, wallpaperPath) {
       if (!element) return;

       if (wallpaperPath && wallpaperPath !== 'none') {
           // We still need to fix potential path issues before sending to main
           const fixedPath = fixWallpaperPath(wallpaperPath);
           
           // Request the thumbnail from the main process. If it fails, fallback to full image.
           window.electronAPI.getWallpaperThumbnail(fixedPath).then(thumbnailUrl => {
               element.style.backgroundImage = `url('${escapeCssUrl(thumbnailUrl)}')`;
           }).catch(err => {
               console.error(`Failed to generate or load thumbnail for ${fixedPath}:`, err);
               element.style.backgroundImage = `url('${escapeCssUrl(fixedPath)}')`;
           });
       } else {
           element.style.backgroundImage = 'none';
       }
   }

    // 1. Fetch themes from the main process
    window.electronAPI.getThemes().then(themeList => {
        themes = themeList;
        // The backend now returns { dark: {...}, light: {...} }.
        // We don't need to pre-process themes here anymore as updatePreview handles it.
        renderThemeCards();
        // Select and preview the first theme by default
        if (themes.length > 0) {
            selectTheme(themes[0].fileName);
        }
    });

    // 2. Render theme cards with the new dual-theme design
    function renderThemeCards() {
        themesGrid.innerHTML = '';
        themes.forEach(theme => {
            const card = document.createElement('div');
            card.className = 'theme-card';
            card.dataset.fileName = theme.fileName;

            const preview = document.createElement('div');
            preview.className = 'card-preview';

            const pane1 = document.createElement('div');
            pane1.className = 'card-preview-pane-1';
            // Use dark theme for the left side of the card preview
            if (theme.variables.dark) {
                pane1.style.backgroundColor = theme.variables.dark['--secondary-bg'] || '#172A46';
                loadWallpaperPreview(pane1, theme.variables.dark['--chat-wallpaper-dark']);
            }
            pane1.style.backgroundSize = 'cover';
            pane1.style.backgroundPosition = 'center';
 
            const pane2 = document.createElement('div');
            pane2.className = 'card-preview-pane-2';
            // Use light theme for the right side of the card preview
            if (theme.variables.light) {
                pane2.style.backgroundColor = theme.variables.light['--primary-bg'] || '#F0F8FF';
                // For the card, prefer the light wallpaper, fallback to dark, then none.
                const lightWallpaper = theme.variables.light['--chat-wallpaper-light'];
                const darkWallpaper = theme.variables.dark ? theme.variables.dark['--chat-wallpaper-dark'] : 'none';
                loadWallpaperPreview(pane2, lightWallpaper || darkWallpaper);
            }
            pane2.style.backgroundSize = 'cover';
            pane2.style.backgroundPosition = 'center';
            
            preview.appendChild(pane1);
            preview.appendChild(pane2);

            const name = document.createElement('h3');
            name.textContent = theme.name;

            card.appendChild(preview);
            card.appendChild(name);

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
            // Set pane-specific variables for mock elements inside this pane
            pane1.style.setProperty('--secondary-text', darkVars['--secondary-text']);
            
            // Set the pane's actual background color (with transparency)
            // This pane simulates the "secondary" area (e.g., sidebar)
            pane1.style.backgroundColor = hexToRgba(darkVars['--secondary-bg'], 0.85);

            // Set the wallpaper on the dedicated background element
            if (wallpaper1) {
                loadWallpaperPreview(wallpaper1, darkVars['--chat-wallpaper-dark']);
            }

            // Apply button styles for dark theme by directly styling the buttons
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
            // Set pane-specific variables for mock elements inside this pane
            pane2.style.setProperty('--secondary-text', lightVars['--secondary-text']);

            // Set the pane's actual background color (with transparency)
            pane2.style.backgroundColor = hexToRgba(lightVars['--primary-bg'], 0.85);

            // Set the wallpaper on the dedicated background element
            if (wallpaper2) {
                const lightWallpaper = lightVars['--chat-wallpaper-light'];
                const darkWallpaper = darkVars ? fixWallpaperPath(darkVars['--chat-wallpaper-dark']) : 'none';
                loadWallpaperPreview(wallpaper2, lightWallpaper || darkWallpaper);
            }

            // Apply button styles for light theme by directly styling the buttons
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
        
        // --- Update container's glow effect (still based on dark theme's button for consistency) ---
        if (darkVars) {
            container.style.setProperty('--button-bg', darkVars['--button-bg'] || '#007bff');
            container.style.setProperty('--button-bg-rgb', hexToRgb(darkVars['--button-bg']) || '0, 123, 255');
        }
    }

    // 5. Save the selected theme
    saveThemeBtn.addEventListener('click', () => {
        if (selectedTheme) {
            window.electronAPI.applyTheme(selectedTheme.fileName);
        }
    });

    // --- Custom Title Bar Listeners ---
    const minimizeBtn = document.getElementById('minimize-theme-btn');
    const maximizeBtn = document.getElementById('maximize-theme-btn');
    const closeBtn = document.getElementById('close-theme-btn');

    minimizeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.minimizeWindow();
    });

    maximizeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.maximizeWindow();
    });

    closeBtn.addEventListener('click', () => {
        window.close();
    });
 
     // --- Theme Handling for the window itself ---
     const applyThemeForWindow = (theme) => {
        document.body.classList.toggle('light-theme', theme === 'light');
    };

    async function initializeTheme() {
        try {
            const theme = await window.electronAPI.getCurrentTheme();
            applyThemeForWindow(theme || 'dark');
        } catch (error) {
            console.error('Failed to get initial theme for themes window:', error);
            applyThemeForWindow('dark'); // Fallback
        }
    }

    if (window.electronAPI) {
        initializeTheme();
        window.electronAPI.onThemeUpdated(applyThemeForWindow);
    } else {
        console.warn('electronAPI not found. Theme updates will not work.');
        applyThemeForWindow('dark');
    }
});