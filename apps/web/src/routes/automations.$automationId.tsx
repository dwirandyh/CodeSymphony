import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/automations/$automationId")({
  component: AutomationDetailRouteComponent,
});

function AutomationDetailRouteComponent() {
  const params = Route.useParams();
  const navigate = useNavigate();

  useEffect(() => {
    void navigate({
      to: "/",
      search: {
        view: "automations",
        automationId: params.automationId,
        automationCreate: undefined,
      },
      replace: true,
    });
  }, [navigate, params.automationId]);

  return null;
}
