import { Driver } from '../../../webdriver/driver';

/**
 * The RPC URL sub-form of the network details form, where a single RPC
 * endpoint's URL and display name are entered.
 *
 * Screen: `#/networks?view=add-rpc` and `#/networks?view=edit-rpc`, reached
 * from `AddEditNetworkPage.openAddRpcUrlPage`.
 * Owns: the RPC URL and RPC name fields, the invalid-URL error, and saving or
 * cancelling the sub-form.
 * Boundaries: saving here only returns to the network form - the RPC is not
 * persisted until that form is saved. Asserting the resulting RPC list belongs
 * to `AddEditNetworkPage`.
 * Related: `AddEditNetworkPage` (opens this, and where both save and cancel
 * return to).
 *
 * @see ui/pages/networks/add-rpc-url-page-form.tsx
 */
class AddEditRpcUrlPage {
  private readonly addRpcNameInput = {
    testId: 'rpc-name-input-test',
  };

  private readonly addRpcUrlButton = {
    text: 'Add URL',
    tag: 'button',
  };

  private readonly addRpcUrlInput = {
    testId: 'rpc-url-input-test',
  };

  private readonly cancelButton = {
    testId: 'page-container-footer-cancel',
  };

  private readonly driver: Driver;

  private readonly errorMessageFailedToFetchChainId = {
    text: 'Could not fetch chain ID. Is your RPC URL correct?',
    tag: 'p',
  };

  private readonly errorMessageInvalidUrl = {
    text: 'URLs require the appropriate HTTP/HTTPS prefix.',
    tag: 'p',
  };

  private readonly settingsV2AddRpcUrlButton =
    '[data-testid="page-container-footer-next"]';

  constructor(driver: Driver) {
    this.driver = driver;
  }

  /**
   * Checks if the add RPC URL button is enabled on the RPC URL page.
   *
   * @param shouldBeEnabled - Whether the add RPC URL button should be enabled. Defaults to true.
   */
  async checkAddRpcUrlButtonIsEnabled(
    shouldBeEnabled: boolean = true,
  ): Promise<void> {
    console.log(
      `Check that add RPC URL button is ${
        shouldBeEnabled ? 'enabled' : 'disabled'
      }`,
    );
    await this.driver.waitForSelector(this.addRpcUrlButton, {
      state: shouldBeEnabled ? 'enabled' : 'disabled',
    });
  }

  async checkErrorMessageFailedToFetchChainIdIsDisplayed(): Promise<void> {
    console.log('Check that failed chain ID fetch error message is displayed');
    await this.driver.waitForSelector(this.errorMessageFailedToFetchChainId);
  }

  async checkErrorMessageInvalidUrlIsDisplayed(): Promise<void> {
    console.log('Check that error message invalid URL is displayed');
    await this.driver.waitForSelector(this.errorMessageInvalidUrl);
  }

  async checkPageIsLoaded(): Promise<void> {
    try {
      await this.driver.waitForSelector(this.addRpcUrlInput);
      await this.driver.waitUntil(async () => {
        const legacyButtonVisible = await this.driver.isElementPresentAndVisible(
          this.addRpcUrlButton,
        );

        if (legacyButtonVisible) {
          return true;
        }

        return await this.driver.isElementPresentAndVisible(
          this.settingsV2AddRpcUrlButton,
        );
      }, {
        interval: 200,
        timeout: 10_000,
      });
    } catch (e) {
      console.log('Timeout while waiting for the RPC URL page to be loaded', e);
      throw e;
    }
    console.log('RPC URL page was loaded');
  }

  async clickCancel(): Promise<void> {
    console.log('Cancel out of the RPC URL page');
    await this.driver.clickElementAndWaitToDisappear(this.cancelButton);
  }

  /**
   * Fill the add RPC name input field.
   *
   * @param rpcName - The RPC name to fill in the input field.
   */
  async fillAddRpcNameInput(rpcName: string): Promise<void> {
    console.log(`Fill RPC name input with ${rpcName} on the RPC URL page`);
    const rpcNameInput = await this.driver.findElement(this.addRpcNameInput);
    await rpcNameInput.sendKeys(rpcName);
  }

  /**
   * Fill the add RPC URL input field.
   *
   * @param rpcUrl - The RPC URL to fill in the input field.
   */
  async fillAddRpcUrlInput(rpcUrl: string): Promise<void> {
    console.log(`Fill RPC URL input with ${rpcUrl} on the RPC URL page`);
    const rpcUrlInput = await this.driver.findElement(this.addRpcUrlInput);
    await rpcUrlInput.sendKeys(rpcUrl);
  }

  async saveAddRpcUrl(): Promise<void> {
    console.log('Confirm added RPC URL');

    const saveButton =
      (await this.driver.isElementPresentAndVisible(
        this.settingsV2AddRpcUrlButton,
      ))
        ? this.settingsV2AddRpcUrlButton
        : this.addRpcUrlButton;

    await this.driver.waitUntil(async () => {
      const button = await this.driver.findElement(saveButton);
      return await button.isEnabled();
    }, {
      interval: 200,
      timeout: 10_000,
    });

    await this.driver.clickElement(saveButton);
    await this.driver.assertElementNotPresent(this.addRpcUrlInput, {
      waitAtLeastGuard: 300,
      timeout: 20_000,
    });
  }
}

export default AddEditRpcUrlPage;
