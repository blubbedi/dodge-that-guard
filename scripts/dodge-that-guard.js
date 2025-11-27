const MODULE_ID = 'dodge-that-guard';
const SOCKET_NAME = `module.${MODULE_ID}`;

// Initialisierung
Hooks.once('ready', () => {
    // Socket Listener
    game.socket.on(SOCKET_NAME, (payload) => {
        if (payload.type === 'requestConfig' && game.user.isGM) {
            new DodgeConfig(payload.actorId, payload.userId).render(true);
        } 
        else if (payload.type === 'startGame' && payload.targetUserId === game.user.id) {
            new DodgeGame(payload.config).render(true);
        }
    });
});

// Button in Actor Sheet (DND5e)
Hooks.on('renderActorSheet5eCharacter', (app, html, data) => {
    const stealthRow = html.find('.skill[data-key="ste"]');
    if (!stealthRow.length) return;

    const btn = $(`<a class="dtg-sheet-btn" title="Dodge That Guard (Heimlichkeit Check)"><i class="fas fa-user-secret"></i></a>`);
    
    btn.click(ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const actorId = app.actor.id;

        if (game.user.isGM) {
            new DodgeConfig(actorId, game.user.id).render(true);
        } else {
            ui.notifications.info("Warte auf GM Konfiguration...");
            game.socket.emit(SOCKET_NAME, {
                type: 'requestConfig',
                actorId: actorId,
                userId: game.user.id
            });
        }
    });

    stealthRow.find('.skill-name').before(btn);
});

/**
 * GM Konfigurations-Fenster
 */
class DodgeConfig extends FormApplication {
    constructor(actorId, requesterId) {
        super();
        this.actor = game.actors.get(actorId);
        this.requesterId = requesterId;
    }

    static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
            title: "Wachen ausweichen: Konfiguration",
            id: "dtg-config",
            template: `modules/${MODULE_ID}/templates/config-placeholder.hbs`, // Wir nutzen Inline HTML unten
            width: 320,
            height: "auto"
        });
    }

    // Automatische Prüfung auf Rüstungs-Nachteil (D&D 5e)
    _checkArmorDisadvantage() {
        if (!this.actor) return false;
        // Durchsuche Items nach Ausrüstung, die equipped ist und Disadvantage gibt
        return this.actor.items.some(i => 
            i.type === "equipment" && 
            i.system.equipped && 
            i.system.stealthDisadvantage
        );
    }

    render(force, options) {
        const bonus = this.actor.system.skills.ste.total;
        const hasArmorDis = this._checkArmorDisadvantage();
        
        // Rogue Reliable Talent Logic (Level 11+)
        const rogueLevels = this.actor.classes?.rogue?.system?.levels || 0;
        const reliable = rogueLevels >= 11;

        const content = `
        <form style="padding:10px;">
            <h3>${this.actor.name}</h3>
            <div class="form-group">
                <label>Schwierigkeit (DC):</label>
                <input type="number" name="dc" value="15">
            </div>
            <div class="form-group">
                <label>Skill Bonus:</label>
                <input type="number" name="bonus" value="${bonus}" readonly>
            </div>
            <div class="form-group">
                <label>Rüstungs-Nachteil?</label>
                <input type="checkbox" name="disadvantage" ${hasArmorDis ? "checked" : ""}>
                <p class="notes" style="font-size:0.8em; color:#888;">${hasArmorDis ? "Automatisch erkannt: Schwere/Mittlere Rüstung." : ""}</p>
            </div>
            <div class="form-group">
                <label>Vorteil (Advantage)?</label>
                <input type="checkbox" name="advantage">
            </div>
            <div class="form-group">
                <label>Reliable Talent?</label>
                <input type="checkbox" name="reliable" ${reliable ? "checked" : ""}>
            </div>
            <hr>
            <button type="button" id="dtg-start-btn"><i class="fas fa-play"></i> Start Game</button>
        </form>
        `;

        const d = new Dialog({
            title: "Dodge That Guard Config",
            content: content,
            buttons: {},
            render: (html) => {
                html.find('#dtg-start-btn').click(() => {
                    const config = {
                        actorId: this.actor.id,
                        dc: parseInt(html.find('[name="dc"]').val()),
                        bonus: parseInt(html.find('[name="bonus"]').val()),
                        disadvantage: html.find('[name="disadvantage"]').is(':checked'),
                        advantage: html.find('[name="advantage"]').is(':checked'),
                        reliable: html.find('[name="reliable"]').is(':checked')
                    };
                    
                    this._startGame(config);
                    d.close();
                });
            }
        });
        d.render(true);
    }

    _startGame(config) {
        if (this.requesterId === game.user.id) {
            new DodgeGame(config).render(true);
        } else {
            game.socket.emit(SOCKET_NAME, {
                type: 'startGame',
                targetUserId: this.requesterId,
                config: config
            });
            ui.notifications.info(`Spiel bei ${this.actor.name} gestartet.`);
        }
    }
}

/**
 * Das Spiel-Fenster (Superball Clone)
 */
class DodgeGame extends Application {
    constructor(config) {
        super();
        this.config = config;
        this.gameRunning = false;
        this.playerX = 50;
        this.guards = []; // aka Balls
        this.scoreTime = 0;
        this.lives = 3; // Man darf Fehler machen
    }

    static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
            id: 'dodge-game-app',
            title: 'Dodge That Guard!',
            template: `modules/${MODULE_ID}/templates/game.hbs`, // Inline wird unten simuliert, falls nötig
            width: 450,
            height: 600,
            resizable: false,
            classes: ['dtg-window']
        });
    }

    getData() {
        return {
            dc: this.config.dc,
            bonus: this.config.bonus,
            lives: this.lives
        };
    }

    // Da wir keine externe HBS Datei anlegen wollen, überschreiben wir _render, 
    // um HTML direkt zu injizieren (oder man legt die Datei an). 
    // Hier der Sauberkeit halber der Inhalt, den du in 'templates/game.hbs' packen solltest:
    /*
    <div class="dtg-header">
        <span class="dtg-stat">DC: {{dc}}</span>
        <span class="dtg-stat">Lives: <span id="dtg-lives">{{lives}}</span></span>
        <span class="dtg-stat warn">Time: <span id="dtg-timer">0.0</span>s</span>
    </div>
    <div id="dtg-canvas" class="dtg-canvas">
        <div id="dtg-player" class="dtg-player"></div>
        <div id="dtg-overlay" style="position:absolute; top:40%; width:100%; text-align:center; display:none; font-size:2em; font-weight:bold; color:red;">GETROFFEN!</div>
    </div>
    */
    
    // Für dieses Beispiel nutze ich eine direkte Render-Methode, falls Template fehlt:
    async _renderInner(...args) {
        const html = await super._renderInner(...args);
        if (html.length === 0) {
            // Fallback content building
            return $(`
                <div class="dtg-window">
                    <div class="dtg-header">
                        <span class="dtg-stat">DC: ${this.config.dc}</span>
                        <span class="dtg-stat">Lives: <span id="dtg-lives">3</span></span>
                        <span class="dtg-stat">Bonus: ${this.config.bonus}</span>
                        <span class="dtg-stat warn" style="margin-left:auto;">Zeit: <span id="dtg-timer">0.0</span>s</span>
                    </div>
                    <div id="dtg-canvas" class="dtg-canvas">
                        <div id="dtg-player" class="dtg-player"></div>
                        <div id="dtg-start-msg" style="position:absolute; top:40%; width:100%; text-align:center; color:#888;">Klicken zum Starten</div>
                    </div>
                </div>
            `);
        }
        return html;
    }

    activateListeners(html) {
        super.activateListeners(html);
        this.canvas = html.find('#dtg-canvas');
        this.playerElem = html.find('#dtg-player');
        this.timerElem = html.find('#dtg-timer');
        this.livesElem = html.find('#dtg-lives');

        this.canvas.on('click', () => {
            if (!this.gameRunning) {
                html.find('#dtg-start-msg').hide();
                this.startGame();
            }
        });

        // Maus Steuerung
        this.canvas.on('mousemove', (ev) => {
            if (!this.gameRunning) return;
            const rect = this.canvas[0].getBoundingClientRect();
            let x = ev.clientX - rect.left;
            this.playerX = (x / rect.width) * 100;
            this.playerX = Math.max(2, Math.min(98, this.playerX));
            this.playerElem.css('left', `${this.playerX}%`);
        });
    }

    startGame() {
        this.gameRunning = true;
        this.startTime = Date.now();
        this.lastFrame = performance.now();
        this.guards = [];
        this.spawnTimer = 0;
        this.lives = 3;
        
        requestAnimationFrame(this.loop.bind(this));
    }

    loop(now) {
        if (!this.gameRunning) return;
        const dt = (now - this.lastFrame) / 1000;
        this.lastFrame = now;

        // Timer Update
        const currentTime = (Date.now() - this.startTime) / 1000;
        this.scoreTime = currentTime;
        this.timerElem.text(currentTime.toFixed(1));

        // Spawn Logik
        // Basis Rate minus Bonus (Bonus macht es langsamer/einfacher)
        // Disadvantage macht es viel schneller
        let spawnRate = 0.8; 
        if (this.config.disadvantage) spawnRate = 0.4; 
        if (this.config.advantage) spawnRate = 1.2;
        
        // Bonus hilft leicht
        spawnRate += (this.config.bonus * 0.02);

        this.spawnTimer += dt;
        if (this.spawnTimer > spawnRate) {
            this.spawnGuard();
            this.spawnTimer = 0;
        }

        this.updateGuards(dt);
        
        // Ziel: Überlebe lang genug? Oder Open End?
        // Sagen wir: Man muss (DC + Bonus/2) Sekunden überleben für "Auto Success"?
        // Oder wir nehmen das Ergebnis am Ende. Hier Open End bis 0 Leben.

        if (this.lives > 0) {
            requestAnimationFrame(this.loop.bind(this));
        } else {
            this.endGame();
        }
    }

    spawnGuard() {
        const guard = $('<div class="dtg-guard"></div>');
        const startX = Math.random() * 90 + 5;
        // Reliable Talent macht Wachen kleiner (leichter auszuweichen)
        const size = this.config.reliable ? 20 : 35; 
        
        guard.css({ left: `${startX}%`, width: `${size}px`, height: `${size}px`, top: '-40px' });
        this.canvas.append(guard);
        
        // Geschwindigkeit basiert auf DC
        const speed = 25 + (this.config.dc * 2.5); // DC 10 = 50 speed, DC 20 = 75 speed

        this.guards.push({
            el: guard,
            x: startX,
            y: -5,
            speed: speed,
            widthPct: (size / this.canvas.width()) * 100 // Näherungswert für Kollision
        });
    }

    updateGuards(dt) {
        const pX = this.playerX;
        const pWidth = 5; // Spieler Breite in %

        for (let i = this.guards.length - 1; i >= 0; i--) {
            let g = this.guards[i];
            g.y += g.speed * dt;
            g.el.css('top', `${g.y}%`);

            // Kollision
            // Einfache 1D Distanzprüfung auf X-Achse wenn Y auf gleicher Höhe
            if (g.y > 85 && g.y < 95) {
                // Konvertiere % in simple Distanz
                if (Math.abs(g.x - pX) < (pWidth + 2)) {
                    this.hit(i);
                    continue;
                }
            }

            if (g.y > 105) {
                g.el.remove();
                this.guards.splice(i, 1);
            }
        }
    }

    hit(index) {
        // Visuelles Feedback
        const g = this.guards[index];
        g.el.css('background', 'red');
        g.el.fadeOut(200, function() { $(this).remove(); });
        this.guards.splice(index, 1);

        this.lives--;
        this.livesElem.text(this.lives);
        
        // Kurzer Screen Shake
        this.canvas.css('transform', 'translate(2px, 2px)');
        setTimeout(() => this.canvas.css('transform', 'none'), 50);

        if (this.lives <= 0) {
            this.gameRunning = false;
        }
    }

    endGame() {
        this.gameRunning = false;
        
        // Ergebnis Berechnung
        // Score = Überlebte Zeit + Bonus
        let resultScore = Math.floor(this.scoreTime) + this.config.bonus;
        
        // Reliable Talent Minumum
        if (this.config.reliable && resultScore < 10) resultScore = 10;

        const success = resultScore >= this.config.dc;
        const color = success ? "green" : "red";
        const resultText = success ? "ERFOLG" : "FEHLSCHLAG";

        // Chat Nachricht
        const content = `
            <div class="dtg-chat-card">
                <h3>Stealth Check: ${this.config.actorId ? game.actors.get(this.config.actorId).name : 'Spieler'}</h3>
                <div>Zeit überlebt: <b>${this.scoreTime.toFixed(1)}s</b></div>
                <div>+ Bonus: ${this.config.bonus}</div>
                <div style="font-size: 1.2em; border-top: 1px solid #333; margin-top:5px; padding-top:5px;">
                    Ergebnis: <b>${resultScore}</b> vs DC ${this.config.dc}
                </div>
                <h2 style="color:${color}; text-align:center;">${resultText}</h2>
            </div>
        `;

        ChatMessage.create({ content });
        
        this.canvas.find('#dtg-start-msg').text("Game Over").show();
        setTimeout(() => this.close(), 3000);
    }
}