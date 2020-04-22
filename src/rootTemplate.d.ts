/* spell-checker: disable */
declare module "chargebee" {
  namespace Chargebee {
    interface Configuration {
      /**
       * @default "https"
       */
      protocol: string;
      /**
       * @default ".chargebee.com"
       */
      hostSuffix: string;
      /**
       * @default "/api/v2"
       */
      apiPath: string;
      /**
       * @default 40000
       */
      timeout: number;
      /**
       * @default "v2.5.7"
       */
      clientVersion: string;
      /**
       * @default 443
       */
      port: number;
      /**
       * @default 3000
       */
      timemachineWaitInMillis: number;
      /**
       * @default 3000
       */
      exportWaitInMillis: number;
    }

    interface ResponseErrorObjectBase {
      /**
       * A descriptive information about the error. This is for
       * developer(/merchant) consumption and should not be used for showing
       * errors to your customers.
       */
      message: string;
    }

    interface ErrorTypeMap {
      payment: void;
      invalid_request: void;
      operation_failed: void;
      io_error: void;
      client_error: void;
    }

    interface ErrorCodeMap {
      payment_processing_failed: void;
      payment_method_verification_failed: void;
      payment_method_not_present: void;
    }

    // interface RequestCallback<Response> {}

    interface RequestWrapper<Response> {
      headers(headers: object): RequestWrapper<Response>;

      // request(callBack?: any);
    }

    function configure(configuration: Partial<Configuration>): void;
  }

  export = Chargebee;
}
