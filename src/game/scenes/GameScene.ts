import Phaser from "phaser";
import { Player } from "../entities/Player";
import { Powerup } from "../entities/Powerup";
import { KnightConfig } from "../config/KnightConfig";

export class GameScene extends Phaser.Scene {
  // Game objects
  private player!: Player;
  private otherPlayers: Map<string, Player> = new Map();
  private projectiles: Map<string, Phaser.Physics.Arcade.Sprite> = new Map();
  private powerups: Phaser.Physics.Arcade.Group | null = null;
  private attackHitbox: Phaser.GameObjects.Rectangle | null = null;
  private hitPlayers: Set<string> = new Set(); // Track which players have been hit by current attack
  
  // Map elements
  private map!: Phaser.Tilemaps.Tilemap;
  private obstacles!: Phaser.Physics.Arcade.StaticGroup;
  
  // Game data
  private playerName: string = "";
  private roomId: string = "";
  private server: any = null;
  private lastPositionUpdate: number = 0;
  private positionUpdateInterval: number = 50; // ms
  private myAccount: string = "";
  private serverInitialized: boolean = false;
  private assetsLoaded: boolean = false;
  private obstaclesCreated: boolean = false;
  
  // Player color tracking
  private usedColorIndices: Set<number> = new Set();
  
  // Input handling
  private spaceKey: Phaser.Input.Keyboard.Key | null = null;
  private attackCooldown: boolean = false;
  
  // Track damaged players and their health
  private damagedPlayers: Map<string, number> = new Map();
  // Track when damage was applied to prevent race conditions
  private damageTimestamps: Map<string, number> = new Map();
  
  // Track player animation states
  private playerAnimations: Map<string, string> = new Map();
  
  // Track dead players to prevent auto-respawn
  private deadPlayers: Set<string> = new Set();
  
  constructor() {
    super({ key: "GameScene" });
  }

  setGameData(data: { playerName: string; roomId: string; server: any }) {
    this.playerName = data.playerName;
    this.roomId = data.roomId;
    this.server = data.server;
    
    if (this.server && this.server.account) {
      this.myAccount = this.server.account;
      this.serverInitialized = true;
      
      // Set up subscriptions after server is initialized
      if (this.scene.isActive()) {
        this.setupServerSubscriptions();
        
        // Send initial player data
        this.updatePlayerOnServer();
      }
    }
  }

  preload() {
    // Load game assets
    this.load.spritesheet("knight", KnightConfig.spriteSheet, {
      frameWidth: KnightConfig.frameWidth,
      frameHeight: KnightConfig.frameHeight
    });
    this.load.image("projectile", "https://raw.githubusercontent.com/photonstorm/phaser3-examples/master/public/assets/sprites/bullets/bullet7.png");
    this.load.image("powerup", "https://raw.githubusercontent.com/photonstorm/phaser3-examples/master/public/assets/sprites/orb-red.png");
    this.load.image("obstacle", "https://raw.githubusercontent.com/photonstorm/phaser3-examples/master/public/assets/sprites/block.png");
    this.load.image("background", "https://raw.githubusercontent.com/photonstorm/phaser3-examples/master/public/assets/skies/space3.png");
  }

  create() {
    // Create background
    this.add.tileSprite(0, 0, 2000, 2000, "background").setOrigin(0, 0);
    
    // Create game world bounds
    this.physics.world.setBounds(0, 0, 2000, 2000);
    
    // Initialize obstacles - will be created after receiving server data
    this.obstacles = this.physics.add.staticGroup();
    
    // Create knight animations
    this.createKnightAnimations();
    
    // Create player
    this.player = new Player(
      this,
      Phaser.Math.Between(100, 1900),
      Phaser.Math.Between(100, 1900),
      "knight",
      this.playerName,
      this.myAccount
    );
    
    // Setup camera to follow player
    this.cameras.main.setBounds(0, 0, 2000, 2000);
    this.cameras.main.startFollow(this.player.sprite, true, 0.09, 0.09);
    this.cameras.main.setZoom(1);
    
    // Create powerups group
    this.powerups = this.physics.add.group();
    
    // Setup input
    this.setupInput();
    
    // Set up server subscriptions if server is already initialized
    if (this.serverInitialized) {
      this.setupServerSubscriptions();
      
      // Send initial player data
      this.updatePlayerOnServer();
    }
    
    // Add help text
    this.add.text(16, 16, "Use arrow keys or WASD to move, SPACE to attack", {
      fontSize: "18px",
      color: "#ffffff",
      backgroundColor: "#000000",
      padding: { x: 10, y: 5 }
    }).setScrollFactor(0).setDepth(100);
    
    // Mark assets as loaded
    this.assetsLoaded = true;
  }

  private createKnightAnimations() {
    const { animations } = KnightConfig;
    
    // Create idle animation
    this.anims.create({
      key: animations.idle.key,
      frames: this.anims.generateFrameNumbers("knight", {
        start: animations.idle.frames.start,
        end: animations.idle.frames.end
      }),
      frameRate: animations.idle.frameRate,
      repeat: animations.idle.repeat
    });
    
    // Create walk animation
    this.anims.create({
      key: animations.walk.key,
      frames: this.anims.generateFrameNumbers("knight", {
        start: animations.walk.frames.start,
        end: animations.walk.frames.end
      }),
      frameRate: animations.walk.frameRate,
      repeat: animations.walk.repeat
    });
    
    // Create attack animation
    this.anims.create({
      key: animations.attack.key,
      frames: this.anims.generateFrameNumbers("knight", {
        start: animations.attack.frames.start,
        end: animations.attack.frames.end
      }),
      frameRate: animations.attack.frameRate,
      repeat: animations.attack.repeat
    });
  }

  private setupServerSubscriptions() {
    if (!this.server || !this.roomId) return;
    
    // Subscribe to projectile creation events
    this.server.onRoomMessage(this.roomId, "projectileFired", this.handleProjectileFired.bind(this));
    
    // Subscribe to powerup creation events
    this.server.onRoomMessage(this.roomId, "powerupSpawned", this.handlePowerupSpawned.bind(this));
    
    // Subscribe to room state for obstacles
    this.server.subscribeRoomState(this.roomId, (state: any) => {
      if (state && state.obstacles && !this.obstaclesCreated) {
        this.createObstaclesFromServer(state.obstacles);
      }
    });
    
    // Subscribe to player hit events to ensure health sync
    this.server.onRoomMessage(this.roomId, "playerHitSync", this.handlePlayerHitSync.bind(this));
    
    // Subscribe to player animation events
    this.server.onRoomMessage(this.roomId, "playerAnimation", this.handlePlayerAnimation.bind(this));
    
    // Subscribe to player attack events
    this.server.onRoomMessage(this.roomId, "playerAttack", this.handlePlayerAttack.bind(this));
    
    // Subscribe to all room user states for player synchronization
    this.server.subscribeRoomAllUserStates(this.roomId, (states: any[]) => {
      if (states && Array.isArray(states)) {
        this.updatePlayerStates(states);
      }
    });
  }

  update(time: number, delta: number) {
    // Update player
    if (this.player) {
      this.player.update();
      
      // Send position updates at fixed intervals
      if (this.serverInitialized && time - this.lastPositionUpdate > this.positionUpdateInterval) {
        this.updatePlayerOnServer();
        this.lastPositionUpdate = time;
      }
      
      // Check for spacebar attack
      if (this.spaceKey && Phaser.Input.Keyboard.JustDown(this.spaceKey) && !this.attackCooldown) {
        this.handleSpacebarAttack();
      }
      
      // Check for hitbox collisions with other players
      if (this.attackHitbox) {
        this.otherPlayers.forEach((otherPlayer, id) => {
          // Skip players that have already been hit by this attack
          if (this.hitPlayers.has(id)) return;
          
          // Skip players that are dead
          if (otherPlayer.isDead()) return;
          
          const hitboxBounds = this.attackHitbox?.getBounds();
          const playerBounds = otherPlayer.sprite.getBounds();
          
          if (Phaser.Geom.Rectangle.Overlaps(hitboxBounds, playerBounds)) {
            // Register this player as hit to prevent multiple hits from same attack
            this.hitPlayers.add(id);
            
            console.log(`Hitbox collision detected with player: ${id}`);
            
            // Process the hit
            this.handlePlayerHit(id, this.myAccount, "melee_attack");
          }
        });
      }
    }
    
    // Update other players
    this.otherPlayers.forEach(player => player.update());
    
    // Update projectiles
    this.projectiles.forEach((projectile, id) => {
      // Check for projectile collisions with players
      if (this.player && projectile.getData("ownerId") !== this.myAccount && !this.player.isDead()) {
        if (this.physics.overlap(projectile, this.player.sprite)) {
          this.handlePlayerHit(this.myAccount, projectile.getData("ownerId"), id);
          projectile.destroy();
          this.projectiles.delete(id);
        }
      }
      
      // Check for projectile collisions with obstacles
      if (this.physics.overlap(projectile, this.obstacles)) {
        projectile.destroy();
        this.projectiles.delete(id);
      }
      
      // Remove projectiles that have exceeded their lifetime
      const creationTime = projectile.getData("creationTime");
      if (Date.now() - creationTime > 2000) { // 2 seconds lifetime
        projectile.destroy();
        this.projectiles.delete(id);
      }
    });
  }

  // Create obstacles from server data
  private createObstaclesFromServer(obstacleData: any[]) {
    try {
      if (!this.assetsLoaded || this.obstaclesCreated) return;
      
      console.log("Creating obstacles from server data:", obstacleData);
      
      // Clear existing obstacles
      this.obstacles.clear(true, true);
      
      // Create border obstacles (fixed positions)
      this.createBorderObstacles();
      
      // Create obstacles from server data
      if (Array.isArray(obstacleData)) {
        obstacleData.forEach(data => {
          if (data && data.x !== undefined && data.y !== undefined) {
            const obstacle = this.obstacles.create(data.x, data.y, "obstacle");
            obstacle.refreshBody();
          }
        });
      }
      
      // Set up collision between player and obstacles
      this.physics.add.collider(this.player.sprite, this.obstacles);
      
      // Set up collision between other players and obstacles
      this.otherPlayers.forEach(player => {
        this.physics.add.collider(player.sprite, this.obstacles);
      });
      
      this.obstaclesCreated = true;
    } catch (error) {
      console.error("Error creating obstacles from server:", error);
    }
  }
  
  // Create border obstacles (identical on all clients)
  private createBorderObstacles() {
    // Create border walls
    for (let i = 0; i < 2000; i += 50) {
      this.obstacles.create(i, 0, "obstacle").refreshBody();
      this.obstacles.create(i, 2000, "obstacle").refreshBody();
      this.obstacles.create(0, i, "obstacle").refreshBody();
      this.obstacles.create(2000, i, "obstacle").refreshBody();
    }
  }

  private setupInput() {
    // Set up spacebar for attacks
    this.spaceKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
  }
  
  private handleSpacebarAttack() {
    if (!this.player || !this.serverInitialized || this.player.isDead()) return;
    
    // Set attack cooldown
    this.attackCooldown = true;
    
    // Play attack animation
    this.player.playAttackAnimation();
    
    // Get player direction
    const playerSprite = this.player.sprite;
    const direction = playerSprite.flipX ? -1 : 1;
    
    // Clear hit players set for new attack
    this.hitPlayers.clear();
    
    // Create hitbox in front of player
    this.createAttackHitbox(direction);
    
    // Send attack data to server
    const attackData = {
      id: `attack_${this.myAccount}_${Date.now()}`,
      x: playerSprite.x,
      y: playerSprite.y,
      direction: direction,
      ownerId: this.myAccount,
      ownerName: this.playerName
    };
    
    this.server.remoteFunction("playerAttack", [attackData]);
    
    // Reset cooldown after a short delay
    this.time.delayedCall(500, () => {
      this.attackCooldown = false;
    });
  }
  
  private createAttackHitbox(direction: number) {
    // Remove existing hitbox if any
    if (this.attackHitbox) {
      this.attackHitbox.destroy();
    }
    
    const playerSprite = this.player.sprite;
    const hitboxWidth = 80;
    const hitboxHeight = 60;
    
    // Position hitbox in front of player based on direction
    const hitboxX = playerSprite.x + (direction * (playerSprite.width / 2 + hitboxWidth / 2));
    const hitboxY = playerSprite.y;
    
    // Create hitbox
    this.attackHitbox = this.add.rectangle(
      hitboxX,
      hitboxY,
      hitboxWidth,
      hitboxHeight,
      0xff0000,
      0.3 // Semi-transparent for debugging
    );
    
    // Make hitbox visible only in debug mode
    this.attackHitbox.setVisible(false);
    
    // Set depth to ensure hitbox is above background
    this.attackHitbox.setDepth(15);
    
    // Remove hitbox after attack animation duration
    this.time.delayedCall(300, () => {
      if (this.attackHitbox) {
        this.attackHitbox.destroy();
        this.attackHitbox = null;
      }
    });
    
    return this.attackHitbox;
  }

  private handleProjectileFired(data: any) {
    // Check if necessary objects are initialized before creating projectile
    if (!this.scene.isActive() || !this.physics) {
      console.warn("Scene not active or physics not initialized when handling projectile");
      return;
    }
    
    // Don't create projectiles fired by this player (already created locally)
    if (data.ownerId === this.myAccount) return;
    
    try {
      this.createProjectile(data);
    } catch (error) {
      console.error("Error creating projectile:", error);
    }
  }
  
  private createProjectile(data: any) {
    const { x, y, targetX, targetY, id, ownerId } = data;
    
    // Create sprite
    const projectile = this.physics.add.sprite(x, y, "projectile");
    projectile.setScale(0.5);
    projectile.setData("id", id);
    projectile.setData("ownerId", ownerId);
    projectile.setData("creationTime", Date.now());
    
    // Calculate angle and velocity
    const angle = Phaser.Math.Angle.Between(x, y, targetX, targetY);
    projectile.setRotation(angle);
    
    // Set velocity based on angle
    const speed = 500;
    this.physics.velocityFromRotation(angle, speed, projectile.body.velocity);
    
    // Add visual trail effect using simple graphics instead of particles
    const trail = this.add.graphics();
    trail.fillStyle(0xffff00, 0.5);
    trail.fillCircle(x, y, 5);
    
    // Fade out and remove the trail after a short time
    this.tweens.add({
      targets: trail,
      alpha: 0,
      duration: 200,
      onComplete: () => {
        trail.destroy();
      }
    });
    
    // Set depth to ensure projectile is above background
    projectile.setDepth(5);
    
    this.projectiles.set(id, projectile);
    
    // Add collisions with obstacles
    this.physics.add.collider(
      projectile,
      this.obstacles,
      () => {
        projectile.destroy();
        this.projectiles.delete(id);
      },
      undefined,
      this
    );
    
    return projectile;
  }

  private handlePowerupSpawned(data: any) {
    // Check if scene is active and necessary resources are loaded
    if (!this.scene.isActive() || !this.assetsLoaded || !this.powerups) {
      console.warn("Scene not active, assets not loaded, or powerups group not initialized");
      return;
    }
    
    try {
      const powerup = new Powerup(
        this,
        data.x,
        data.y,
        "powerup",
        data.id,
        data.type
      );
      
      if (powerup && powerup.sprite) {
        this.powerups.add(powerup.sprite);
      }
    } catch (error) {
      console.error("Error creating powerup:", error);
    }
  }

  private collectPowerup(playerSprite: Phaser.Physics.Arcade.Sprite, powerupSprite: Phaser.Physics.Arcade.Sprite) {
    if (!powerupSprite) return;
    
    const powerupId = powerupSprite.getData("id");
    const powerupType = powerupSprite.getData("type");
    
    // Apply powerup effect
    if (powerupType === "health") {
      this.player.heal(25);
    } else if (powerupType === "speed") {
      this.player.applySpeedBoost(5000); // 5 seconds
    }
    
    // Remove powerup
    powerupSprite.destroy();
    
    // Notify server if initialized
    if (this.serverInitialized) {
      this.server.remoteFunction("collectPowerup", [powerupId]);
    }
  }

  // Handle player hit sync message from server
  private handlePlayerHitSync(data: any) {
    const { targetId, attackerId, damage, newHealth, timestamp } = data;
    
    // If this is about our player being hit
    if (targetId === this.myAccount) {
      console.log(`Received hit sync for local player. New health: ${newHealth}`);
      // Update our health to match server's value
      this.player.setHealth(newHealth);
      
      // Check if player died
      if (newHealth <= 0) {
        // Dispatch custom event for player death
        window.dispatchEvent(new CustomEvent('player-died'));
        // Add to dead players set
        this.deadPlayers.add(targetId);
      }
    } 
    // If this is about another player being hit
    else if (this.otherPlayers.has(targetId)) {
      const targetPlayer = this.otherPlayers.get(targetId);
      if (targetPlayer) {
        console.log(`Received hit sync for player ${targetId}. New health: ${newHealth}`);
        
        // Get the timestamp of our last local damage to this player
        const lastDamageTime = this.damageTimestamps.get(targetId) || 0;
        
        // If the server message is newer than our last local damage, use the server value
        if (timestamp > lastDamageTime) {
          targetPlayer.setHealth(newHealth);
          // Update our local tracking
          this.damagedPlayers.set(targetId, newHealth);
          
          // If player died, add to dead players set
          if (newHealth <= 0) {
            this.deadPlayers.add(targetId);
          }
        }
      }
    }
  }

  // Handle player animation message from server
  private handlePlayerAnimation(data: any) {
    const { playerId, animation, flipX } = data;
    
    // Skip if this is about our own player (we handle our own animations)
    if (playerId === this.myAccount) return;
    
    // Find the player and update their animation
    if (this.otherPlayers.has(playerId)) {
      const player = this.otherPlayers.get(playerId)!;
      
      // Skip animation updates for dead players
      if (player.isDead()) return;
      
      // Update sprite flip
      if (flipX !== undefined) {
        player.sprite.setFlipX(flipX);
      }
      
      // Play the appropriate animation
      if (animation === "idle") {
        player.playIdleAnimation();
      } else if (animation === "walk") {
        player.playWalkAnimation();
      } else if (animation === "attack") {
        player.playAttackAnimation();
      }
      
      // Store the current animation
      this.playerAnimations.set(playerId, animation);
    }
  }
  
  // Handle player attack message from server
  private handlePlayerAttack(data: any) {
    const { ownerId, x, y, direction } = data;
    
    // Skip if this is our own attack (we already handled it locally)
    if (ownerId === this.myAccount) return;
    
    // Find the player and play attack animation
    if (this.otherPlayers.has(ownerId)) {
      const player = this.otherPlayers.get(ownerId)!;
      
      // Skip attack animation for dead players
      if (player.isDead()) return;
      
      // Update player position if needed
      if (x !== undefined && y !== undefined) {
        player.moveTo(x, y);
      }
      
      // Set sprite flip based on attack direction
      if (direction !== undefined) {
        player.sprite.setFlipX(direction < 0);
      }
      
      // Play attack animation
      player.playAttackAnimation();
    }
  }

  private handlePlayerHit(targetId: string, attackerId: string, projectileId: string) {
    console.log(`Player hit: targetId=${targetId}, attackerId=${attackerId}, projectileId=${projectileId}`);
    
    // Skip if target player is dead
    if (targetId === this.myAccount && this.player.isDead()) return;
    if (targetId !== this.myAccount && this.otherPlayers.has(targetId) && this.otherPlayers.get(targetId)!.isDead()) return;
    
    const timestamp = Date.now();
    const damage = 10; // Fixed damage amount
    
    // Apply damage locally
    if (targetId === this.myAccount) {
      console.log(`Local player hit. Current health: ${this.player.health}`);
      this.player.damage(damage);
      const newHealth = this.player.health;
      console.log(`New health: ${newHealth}`);
      
      // Check if player died
      if (newHealth <= 0) {
        // Dispatch custom event for player death
        window.dispatchEvent(new CustomEvent('player-died'));
        // Add to dead players set
        this.deadPlayers.add(targetId);
      }
    } else if (this.otherPlayers.has(targetId)) {
      console.log(`Other player hit: ${targetId}. Exists: ${this.otherPlayers.has(targetId)}`);
      const targetPlayer = this.otherPlayers.get(targetId);
      if (targetPlayer) {
        console.log(`Other player health before damage: ${targetPlayer.health}`);
        targetPlayer.damage(damage);
        
        // Store the damaged player's new health and timestamp
        const newHealth = targetPlayer.health;
        this.damagedPlayers.set(targetId, newHealth);
        this.damageTimestamps.set(targetId, timestamp);
        
        console.log(`Other player health after damage: ${newHealth}`);
        console.log(`Stored in damagedPlayers: ${this.damagedPlayers.get(targetId)}`);
        
        // If player died, add to dead players set
        if (newHealth <= 0) {
          this.deadPlayers.add(targetId);
        }
      }
    }
    
    // Notify server if initialized
    if (this.serverInitialized) {
      // Send hit data to server
      this.server.remoteFunction("playerHit", [
        {
          targetId,
          attackerId,
          projectileId,
          damage,
          timestamp
        }
      ]);
      
      // Broadcast hit sync to all players in the room
      // This ensures everyone sees the same health values
      if (targetId !== this.myAccount) {
        const newHealth = this.damagedPlayers.get(targetId);
        this.server.remoteFunction("broadcastHitSync", [
          {
            targetId,
            attackerId,
            damage,
            newHealth,
            timestamp
          }
        ]);
      }
    }
  }

  private handlePlayerDeath(playerId: string, killerId: string) {
    if (playerId === this.myAccount) {
      // Notify server if initialized
      if (this.serverInitialized) {
        this.server.remoteFunction("playerDied", [
          {
            playerId,
            killerId
          }
        ]);
      }
    }
  }

  // Respawn player at a specific position
  public respawnPlayer(x: number, y: number) {
    if (!this.player) return;
    
    // Set player position
    this.player.sprite.setPosition(x, y);
    
    // Reset player state
    this.player.reset();
    
    // Remove from dead players set
    this.deadPlayers.delete(this.myAccount);
    
    // Update server with new position and health
    if (this.serverInitialized) {
      this.updatePlayerOnServer();
    }
  }

  private updatePlayerOnServer() {
    if (!this.player || !this.serverInitialized || !this.server) return;
    
    // Get current animation state
    let currentAnimation = "idle";
    if (this.player.sprite.anims.currentAnim) {
      const animKey = this.player.sprite.anims.currentAnim.key;
      if (animKey.includes("walk")) {
        currentAnimation = "walk";
      } else if (animKey.includes("attack")) {
        currentAnimation = "attack";
      }
    }
    
    // Send position and animation data
    const playerData = {
      x: this.player.sprite.x,
      y: this.player.sprite.y,
      angle: this.player.sprite.angle,
      health: this.player.health,
      name: this.playerName,
      animation: currentAnimation,
      flipX: this.player.sprite.flipX
    };
    
    this.server.remoteFunction(
      "updatePlayerPosition",
      [playerData],
      { throttle: 50 }
    );
    
    // If animation changed, send specific animation update
    const lastAnimation = this.playerAnimations.get(this.myAccount) || "idle";
    if (currentAnimation !== lastAnimation) {
      this.playerAnimations.set(this.myAccount, currentAnimation);
      
      this.server.remoteFunction("updatePlayerAnimation", [
        {
          animation: currentAnimation,
          flipX: this.player.sprite.flipX
        }
      ]);
    }
  }

  updateRoomState(roomState: any) {
    // Handle room state updates
    if (roomState.powerups) {
      // Sync powerups with server state
      this.syncPowerups(roomState.powerups);
    }
    
    // Create obstacles if not yet created and obstacle data exists
    if (!this.obstaclesCreated && roomState.obstacles) {
      this.createObstaclesFromServer(roomState.obstacles);
    }
  }

  // Get a unique color index for a player
  private getUniqueColorIndex(playerId: string): number {
    // Start from 1 because 0 is reserved for local player
    for (let i = 1; i < 9; i++) {
      if (!this.usedColorIndices.has(i)) {
        this.usedColorIndices.add(i);
        return i;
      }
    }
    
    // If all colors are used, generate a deterministic index based on player ID
    return Math.abs(this.hashCode(playerId) % 8) + 1;
  }
  
  // Simple string hash function
  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  updatePlayerStates(playerStates: any[]) {
    if (!playerStates) return;
    
    playerStates.forEach(playerState => {
      const playerId = playerState.account;
      
      // Skip our own player (we handle our own state)
      if (playerId === this.myAccount) return;
      
      if (playerState.x !== undefined && playerState.y !== undefined) {
        // Update existing player or create new one
        if (this.otherPlayers.has(playerId)) {
          const player = this.otherPlayers.get(playerId)!;
          
          // Update position with smooth movement
          player.moveTo(playerState.x, playerState.y);
          
          // Update sprite flip if provided
          if (playerState.flipX !== undefined) {
            player.sprite.setFlipX(playerState.flipX);
          }
          
          // Update animation if provided
          if (playerState.animation && playerState.animation !== this.playerAnimations.get(playerId)) {
            this.playerAnimations.set(playerId, playerState.animation);
            
            if (playerState.animation === "idle") {
              player.playIdleAnimation();
            } else if (playerState.animation === "walk") {
              player.playWalkAnimation();
            } else if (playerState.animation === "attack") {
              player.playAttackAnimation();
            }
          }
          
          // Health update logic - MODIFIED TO PREVENT AUTO-RESPAWN
          // Check if player is in dead players set
          if (this.deadPlayers.has(playerId)) {
            // Player is dead, ignore health updates from server
            console.log(`Ignoring health update for dead player ${playerId}`);
            // Ensure player remains dead visually
            if (player.health > 0) {
              player.setHealth(0);
            }
          } else {
            // Player is not dead, proceed with normal health update logic
            const lastDamageTime = this.damageTimestamps.get(playerId) || 0;
            const currentTime = Date.now();
            
            // If we have a recent local damage value (within last 2 seconds), use it
            // Otherwise use the server value
            if (this.damagedPlayers.has(playerId) && currentTime - lastDamageTime < 2000) {
              const localHealth = this.damagedPlayers.get(playerId);
              console.log(`Using locally tracked health for ${playerId}: ${localHealth}`);
              player.setHealth(localHealth);
              
              // If local health is 0, add to dead players set
              if (localHealth <= 0) {
                this.deadPlayers.add(playerId);
              }
            } else {
              // Use server health value
              player.setHealth(playerState.health || 100);
              // Update our local tracking to match server
              if (playerState.health !== undefined) {
                this.damagedPlayers.set(playerId, playerState.health);
                
                // If server health is 0, add to dead players set
                if (playerState.health <= 0) {
                  this.deadPlayers.add(playerId);
                }
              }
            }
          }
        } else {
          // Get a unique color index for this player
          const colorIndex = this.getUniqueColorIndex(playerId);
          
          // Create new player with the same texture as local player but different color
          const newPlayer = new Player(
            this,
            playerState.x,
            playerState.y,
            "knight", // Use the knight texture
            playerState.name || "Unknown",
            playerId,
            colorIndex
          );
          
          // Set initial health from server
          if (playerState.health !== undefined) {
            newPlayer.setHealth(playerState.health);
            
            // If player is joining with 0 health, add to dead players set
            if (playerState.health <= 0) {
              this.deadPlayers.add(playerId);
            }
          }
          
          // Set initial animation
          if (playerState.animation) {
            this.playerAnimations.set(playerId, playerState.animation);
            
            if (playerState.animation === "idle") {
              newPlayer.playIdleAnimation();
            } else if (playerState.animation === "walk") {
              newPlayer.playWalkAnimation();
            } else if (playerState.animation === "attack") {
              newPlayer.playAttackAnimation();
            }
          }
          
          // Set initial flip state
          if (playerState.flipX !== undefined) {
            newPlayer.sprite.setFlipX(playerState.flipX);
          }
          
          this.otherPlayers.set(playerId, newPlayer);
          
          // Set up collision if obstacles are already created
          if (this.obstaclesCreated) {
            this.physics.add.collider(newPlayer.sprite, this.obstacles);
          }
        }
      }
    });
    
    // Remove players that are no longer in the room
    const currentPlayerIds = new Set(playerStates.map(p => p.account));
    this.otherPlayers.forEach((player, id) => {
      if (!currentPlayerIds.has(id)) {
        // Free up the color index when a player leaves
        const colorIndex = this.hashCode(id) % 8 + 1;
        this.usedColorIndices.delete(colorIndex);
        
        // Remove from tracking maps
        this.damagedPlayers.delete(id);
        this.damageTimestamps.delete(id);
        this.playerAnimations.delete(id);
        this.deadPlayers.delete(id);
        
        player.destroy();
        this.otherPlayers.delete(id);
      }
    });
  }

  private syncPowerups(powerupData: any[]) {
    if (!this.powerups || !this.assetsLoaded) return;
    
    try {
      // Clear existing powerups
      this.powerups.clear(true, true);

      // Create powerups from server data
      powerupData.forEach(data => {
        if (!data || !data.id || !data.type) return;
        
        const powerup = new Powerup(
          this,
          data.x,
          data.y,
          "powerup",
          data.id,
          data.type
        );
        
        if (powerup && powerup.sprite) {
          this.powerups?.add(powerup.sprite);
        }
      });
    } catch (error) {
      console.error("Error syncing powerups:", error);
    }
  }
}
