import { registry } from "@/commands";
import { defaultCommand } from "@/commands/default";
import { helpCommand } from "@/commands/help";
import { modelCommand } from "@/commands/model";
import { newCommand } from "@/commands/new";
import { statusCommand } from "@/commands/status";
import { tasksCommand } from "@/commands/tasks";

registry.register(statusCommand);
registry.register(tasksCommand);
registry.register(defaultCommand);
registry.register(modelCommand);
registry.register(helpCommand);
registry.register(newCommand);
