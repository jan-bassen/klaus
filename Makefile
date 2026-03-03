.PHONY: deploy logs pair restart ssh

SERVER=user@your-vps-ip
APP_DIR=/opt/klaus

deploy:
	rsync -av --exclude='node_modules' --exclude='.git' --exclude='auth' \
		./ $(SERVER):$(APP_DIR)/
	ssh $(SERVER) "cd $(APP_DIR) && docker compose build app && docker compose up -d"

logs:
	ssh $(SERVER) "cd $(APP_DIR) && docker compose logs -f app"

pair:
	ssh $(SERVER) "cd $(APP_DIR) && docker compose logs -f app"

restart:
	ssh $(SERVER) "cd $(APP_DIR) && docker compose restart app"

ssh:
	ssh $(SERVER)
