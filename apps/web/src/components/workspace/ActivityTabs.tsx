import type { ReactNode } from "react";
import type { ChatEvent } from "@codesymphony/shared-types";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ScrollArea } from "../ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

type ActivityTabsProps = {
  activeTab: "chat" | "logs";
  toolEvents: ChatEvent[];
  onTabChange: (tab: "chat" | "logs") => void;
  chatContent: ReactNode;
};

export function ActivityTabs({ activeTab, toolEvents, onTabChange, chatContent }: ActivityTabsProps) {
  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader className="border-b border-border/70 p-3">
        <CardTitle className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Activity</CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-3">
        <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as "chat" | "logs")} className="flex h-full min-h-0 flex-col">
          <TabsList className="self-start">
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="logs">Tool Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="chat" className="min-h-0 flex-1">
            {chatContent}
          </TabsContent>

          <TabsContent value="logs" className="min-h-0 flex-1">
            <ScrollArea className="h-full rounded-md border border-border/70 p-2" data-testid="logs-scroll">
              {toolEvents.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  No tool activity yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {toolEvents.map((event) => (
                    <details key={event.id} className="rounded-md border border-border/70 bg-secondary/40 p-2 text-xs">
                      <summary className="cursor-pointer font-medium">
                        [{event.idx}] {event.type}
                      </summary>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    </details>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
