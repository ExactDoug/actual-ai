import { ReceiptConnector } from './types';

export default class ConnectorRegistry {
  private connectors = new Map<string, ReceiptConnector>();

  register(connector: ReceiptConnector): void {
    this.connectors.set(connector.providerId, connector);
  }

  get(providerId: string): ReceiptConnector | undefined {
    return this.connectors.get(providerId);
  }

  getAll(): ReceiptConnector[] {
    return Array.from(this.connectors.values());
  }

  has(providerId: string): boolean {
    return this.connectors.has(providerId);
  }
}
