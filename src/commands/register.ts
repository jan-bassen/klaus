import { registry } from "@/commands";
import { defaultCommand } from "@/commands/default";
import { statusCommand } from "@/commands/status";
import { tasksCommand } from "@/commands/tasks";

registry.register(statusCommand);
registry.register(tasksCommand);
registry.register(defaultCommand);
